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
