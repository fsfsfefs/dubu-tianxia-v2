import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import pytest
from reader_next_api.application import MaintenanceMiddleware
from reader_next_api.runtime import Runtime
from reader_next_api.repository import Repository
from reader_next_api.full_backup import create_full_backup, inspect_backup


def scope(path='/stream', method='GET'):
    return {'type': 'http', 'path': path, 'method': method, 'headers': []}


def test_many_requests_and_long_sse_keep_restore_excluded_until_final_body(tmp_path):
    async def scenario():
        runtime = Runtime(tmp_path, tmp_path)
        release, all_started = asyncio.Event(), asyncio.Event()
        started = 0
        async def application(request, receive, send):
            nonlocal started
            started += 1
            if started == 32: all_started.set()
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            for i in range(100):
                await send({'type': 'http.response.body', 'body': f'data: {i}\n\n'.encode(), 'more_body': True})
                await asyncio.sleep(0)
            await release.wait()
            await send({'type': 'http.response.body', 'body': b'data: done\n\n', 'more_body': False})
        middleware = MaintenanceMiddleware(application, runtime)
        async def receive(): return {'type': 'http.request', 'body': b''}
        messages = [[] for _ in range(32)]
        async def run(index):
            async def send(message): messages[index].append(message)
            await middleware(scope(), receive, send)
        pending = [asyncio.create_task(run(i)) for i in range(32)]
        await asyncio.wait_for(all_started.wait(), 5)
        for _ in range(40):
            rejected = []
            async def send(message): rejected.append(message)
            await middleware(scope('/api/backup/restore', 'POST'), receive, send)
            assert rejected[0]['status'] == 503
        assert runtime._active == 32
        release.set(); await asyncio.wait_for(asyncio.gather(*pending), 10)
        assert all(len(items) == 102 and not items[-1]['more_body'] for items in messages)
        with runtime.lease(exclusive=True):
            assert runtime._active == 1
        assert runtime._active == 0
    asyncio.run(scenario())


@pytest.mark.parametrize('failure', [RuntimeError, asyncio.CancelledError])
def test_failed_or_disconnected_stream_releases_lease(tmp_path, failure):
    async def scenario():
        runtime = Runtime(tmp_path, tmp_path)
        async def broken(scope, receive, send):
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            raise failure()
        async def receive(): return {'type': 'http.request', 'body': b''}
        async def send(message): pass
        with pytest.raises(failure):
            await MaintenanceMiddleware(broken, runtime)(scope(), receive, send)
        with runtime.lease(exclusive=True): pass
        assert runtime._active == 0
    asyncio.run(scenario())


def test_exclusive_restore_rejects_request_burst_and_recovers_after_error(tmp_path):
    runtime = Runtime(tmp_path, tmp_path)
    entered = threading.Event(); release = threading.Event()
    def restore():
        with runtime.lease(exclusive=True):
            entered.set(); assert release.wait(10)
            raise ValueError('invalid backup')
    with ThreadPoolExecutor(max_workers=12) as pool:
        operation = pool.submit(restore); assert entered.wait(5)
        def request(_):
            from reader_next_api.runtime import MaintenanceBusy
            with pytest.raises(MaintenanceBusy), runtime.lease(): pass
        list(pool.map(request, range(150)))
        release.set()
        with pytest.raises(ValueError): operation.result(5)
    with runtime.lease(): pass


def test_restore_waits_for_inflight_worker_before_snapshot_and_replace(tmp_path, monkeypatch):
    runtime = Runtime(tmp_path / 'live', tmp_path)
    runtime.start()
    source = Repository(tmp_path / 'source')
    restored_doc = source.add_document('restored.pdf', b'%PDF-1.7\nrestored')
    source.save_summary_checkpoint(restored_doc['id'], 'kept', 'checkpoint')
    archive = tmp_path / 'source.zip'; create_full_backup(source.root, archive)
    staging = tmp_path / 'staged'; inspect_backup(archive, staging)
    old_doc = runtime.repository.add_document('old.pdf', b'%PDF-1.7\nold')
    entered, release, shutting_down = threading.Event(), threading.Event(), threading.Event()
    class Page:
        def extract_text(self):
            entered.set(); assert release.wait(10)
            return 'finished old page'
    class Reader:
        def __init__(self, path): self.pages = [Page()]
    monkeypatch.setattr('reader_next_api.background_tasks.PdfReader', Reader)
    runtime.task_manager.enqueue_index(old_doc['id'])
    assert entered.wait(5)
    manager = runtime.task_manager
    original = manager.shutdown
    def shutdown(): shutting_down.set(); original()
    monkeypatch.setattr(manager, 'shutdown', shutdown)
    safety = runtime.data_root / 'backups/pre-restore.zip'
    def restore():
        with runtime.lease(exclusive=True): return runtime.restore(staging, safety)
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(restore)
            assert shutting_down.wait(5)
            assert not future.done() and not safety.exists()
            release.set(); counts, _ = future.result(15)
        assert counts['documents'] == 1 and safety.exists()
        assert runtime.repository.list_documents()[0]['id'] == restored_doc['id']
        assert runtime.repository.summary_checkpoint(restored_doc['id'], 'kept') == 'checkpoint'
        assert runtime.task_manager is not manager
        assert runtime.repository.list_background_tasks() == []
        # Independent restart applies migrations idempotently and retains restored data.
        runtime.stop(); runtime.start()
        assert runtime.repository.document_path(restored_doc['id']).exists()
    finally:
        release.set(); runtime.stop()
