import time
from io import BytesIO

from pypdf import PdfWriter

from reader_next_api.background_tasks import BackgroundTaskManager
from reader_next_api.repository import Repository


def pdf_bytes(page_count: int = 2) -> bytes:
    writer = PdfWriter()
    for _ in range(page_count):
        writer.add_blank_page(width=200, height=300)
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def wait_for_task(repository: Repository, task_id: str, timeout: float = 5) -> dict:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        task = repository.background_task(task_id)
        if task["status"] in {"completed", "failed", "cancelled"}:
            return task
        time.sleep(0.02)
    raise AssertionError("background task did not finish")


def test_background_pdf_index_task_is_persisted(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("blank.pdf", pdf_bytes())
    manager = BackgroundTaskManager(repository)
    try:
        task = manager.enqueue_index(document["id"])
        completed = wait_for_task(repository, task["id"])
    finally:
        manager.shutdown()

    assert completed["status"] == "completed"
    assert completed["progress"] == 2
    assert completed["total"] == 2
    assert completed["result"]["blank_pages"] == 2
    assert Repository(tmp_path).list_background_tasks()[0]["id"] == task["id"]


def test_active_index_task_is_deduplicated_and_recovered(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("queued.pdf", pdf_bytes(1))

    first = repository.create_background_task("document-index", document["id"], "index")
    second = repository.create_background_task("document-index", document["id"], "index")
    repository.update_background_task(first["id"], status="running")
    repository.recover_background_tasks()

    recovered = repository.background_task(first["id"])
    assert first["id"] == second["id"]
    assert recovered["status"] == "paused"
    assert "重新执行" in recovered["message"]

def test_summary_pool_is_bounded_and_does_not_block_index(tmp_path, monkeypatch):
    import threading
    from reader_next_api import background_tasks

    repository = Repository(tmp_path)
    documents = [repository.add_document(f"book-{i}.pdf", pdf_bytes(i + 1)) for i in range(5)]
    release = threading.Event()
    three_started = threading.Event()
    lock = threading.Lock()
    started = []

    async def blocked_summary(repo, task_id, *args):
        with lock:
            started.append(task_id)
            if len(started) == 3:
                three_started.set()
        assert release.wait(10)
        repo.update_background_task(task_id, status="completed")

    monkeypatch.setattr(background_tasks, "run_summary", blocked_summary)
    manager = BackgroundTaskManager(repository)
    options = {"chapter_index": None}
    try:
        tasks = [manager.enqueue_summary(doc["id"], options) for doc in documents[:4]]
        assert three_started.wait(5), "three different books must start concurrently"
        assert repository.background_task(tasks[3]["id"])["status"] == "queued"
        assert manager.enqueue_summary(documents[0]["id"], options)["id"] == tasks[0]["id"]
        indexed = wait_for_task(repository, manager.enqueue_index(documents[4]["id"])["id"])
        assert indexed["status"] == "completed"
        release.set()
        for task in tasks:
            assert wait_for_task(repository, task["id"])["status"] == "completed"
        assert len(started) == 4
    finally:
        release.set()
        manager.shutdown()


def test_paused_book_retry_waits_for_inflight_summary(tmp_path, monkeypatch):
    import threading
    from reader_next_api import background_tasks

    repository = Repository(tmp_path)
    document = repository.add_document("book.pdf", pdf_bytes(1))
    entered = threading.Event()
    release = threading.Event()
    calls = []

    async def blocked_summary(repo, task_id, *args):
        calls.append(task_id)
        if len(calls) == 1:
            entered.set()
            assert release.wait(10)
            raise background_tasks.SummaryStopped()
        repo.update_background_task(task_id, status="completed")

    monkeypatch.setattr(background_tasks, "run_summary", blocked_summary)
    manager = BackgroundTaskManager(repository)
    try:
        first = manager.enqueue_summary(document["id"], {"chapter_index": None})
        assert entered.wait(5)
        manager.pause(first["id"])
        retry = manager.retry(first["id"])
        assert retry["id"] != first["id"]
        assert repository.background_task(retry["id"])["status"] == "queued"
        manager.cancel(retry["id"])
        release.set()
        assert wait_for_task(repository, retry["id"])["status"] == "cancelled"
        assert calls == [first["id"]]
        assert repository.background_task(first["id"])["status"] == "paused"
    finally:
        release.set()
        manager.shutdown()
