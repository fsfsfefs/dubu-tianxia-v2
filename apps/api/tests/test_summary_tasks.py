from reader_next_api.chapters import chapter_key
from io import BytesIO
from types import SimpleNamespace

import pytest
from pypdf import PdfWriter

from reader_next_api.domain import ModelProfile
from reader_next_api.repository import Repository
from reader_next_api.summary_tasks import run_summary, split_source, SummaryStopped
from reader_next_api.background_tasks import BackgroundTaskManager


def finish(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coroutine.close()
    raise AssertionError('Unexpected real async operation')


@pytest.fixture
def setup(tmp_path):
    repo = Repository(tmp_path)
    writer = PdfWriter()
    for _ in range(2):
        writer.add_blank_page(width=200, height=300)
    output = BytesIO(); writer.write(output)
    doc = repo.add_document('book.pdf', output.getvalue())['id']
    repo.save_profile(ModelProfile('model', 'Test', 'https://example.com/responses', 'test'))
    repo.save_ocr_page(doc, 1, '概念一。' * 2000)
    repo.save_ocr_page(doc, 2, '概念二。' * 200)
    options = {'profile_id': 'model', 'chapter_index': None, 'outline': [
        {'title': '大章', 'page': 1, 'depth': 0},
        {'title': '小章一', 'page': 1, 'depth': 1},
        {'title': '小章二', 'page': 2, 'depth': 1},
    ]}
    task = repo.create_background_task('structure-summary', doc, '生成全书结构')
    repo.update_background_task(task['id'], result={'summary_request': options})
    return repo, doc, options, task['id']


def test_background_generation_completes_and_saves_all_levels(setup):
    repo, doc, options, task_id = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        yield '【知识骨架】已生成总结〔PDF 1-2〕'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
    assert len(repo.list_chapter_summaries(doc)) == 4
    task = repo.background_task(task_id)
    assert task['status'] == 'completed' and task['progress'] == task['total'] == 4
    assert all(len(text) <= 10000 for text in calls)
    assert 'key' not in str(task['result'])


def test_failed_chunk_is_not_saved_and_retry_reuses_finished_blocks(setup):
    repo, doc, options, task_id = setup
    options['chapter_index'] = 1
    calls = []
    async def failing(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        if len(calls) == 2:
            raise RuntimeError('network failure')
        yield '成功的分块'
    with pytest.raises(RuntimeError, match='network'):
        finish(run_summary(repo, task_id, options, SimpleNamespace(stream=failing), SimpleNamespace(get=lambda _: 'key')))
    first = calls[0]
    async def success(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        yield '合并结果'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=success), SimpleNamespace(get=lambda _: 'key')))
    assert calls.count(first) == 1
    assert repo.background_task(task_id)['status'] == 'completed'
    assert len(repo.list_chapter_summaries(doc)) == 1


def test_pause_prevents_model_calls_and_cancel_preserves_checkpoint(setup):
    repo, doc, options, task_id = setup
    manager = BackgroundTaskManager(repo)
    try:
        manager.pause(task_id)
        async def stream(*args, **kwargs):
            raise AssertionError('must not call model')
            yield ''
        with pytest.raises(SummaryStopped):
            finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
        assert manager.cancel(task_id)['status'] == 'cancelled'
    finally:
        manager.shutdown()


def test_missing_key_and_bad_page_range_fail_without_writes(setup):
    repo, doc, options, task_id = setup
    with pytest.raises(ValueError, match='API Key'):
        finish(run_summary(repo, task_id, options, None, SimpleNamespace(get=lambda _: None)))
    options['outline'][0]['page'] = 99
    with pytest.raises(ValueError, match='总页数'):
        finish(run_summary(repo, task_id, options, None, SimpleNamespace(get=lambda _: 'key')))
    assert repo.list_chapter_summaries(doc) == []


def test_split_preserves_entire_oversized_page():
    text = '甲' * 18000
    parts = split_source('【PDF 7】' + text)
    assert all(len(part) <= 7000 and part.startswith('【PDF 7】') for part in parts)
    assert ''.join(part.replace('【PDF 7】', '') for part in parts) == text


def test_manager_runs_detached_and_persists_retry_parameters(setup, monkeypatch):
    import threading
    from reader_next_api import background_tasks
    repo, doc, options, old_id = setup
    repo.update_background_task(old_id, status='cancelled')
    entered = threading.Event()
    release = threading.Event()
    async def stream(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        yield '总结完成'
    monkeypatch.setattr(background_tasks.asyncio, 'run', finish)
    manager = BackgroundTaskManager(repo, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key'))
    manager.summary_pacer = None
    try:
        task = manager.enqueue_summary(doc, options)
        assert entered.wait(5)
        duplicate = manager.enqueue_summary(doc, options)
        assert duplicate['id'] == task['id']
        assert repo.background_task(task['id'])['result']['summary_request'] == options
        release.set()
        from test_background_tasks import wait_for_task
        done = wait_for_task(repo, task['id'])
        assert done['status'] == 'completed'
        assert len(repo.list_chapter_summaries(doc)) == 4
    finally:
        release.set()
        manager.shutdown()


def test_server_restart_keeps_summary_request_for_resume(setup):
    repo, doc, options, task_id = setup
    repo.update_background_task(task_id, status='running')
    repo.recover_background_tasks()
    restored = Repository(repo.database_path.parent)
    task = restored.background_task(task_id)
    assert task['status'] == 'paused'
    assert task['result']['summary_request'] == options


@pytest.fixture
def no_retry_delay(monkeypatch):
    from reader_next_api import summary_tasks
    async def immediate(_):
        pass
    monkeypatch.setattr(summary_tasks.asyncio, 'sleep', immediate)


def test_transient_disconnect_retries_only_failed_block_without_partial_text(setup, no_retry_delay):
    import httpx
    repo, doc, options, task_id = setup
    options['chapter_index'] = 1
    calls = []
    async def stream(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        if len(calls) == 2:
            yield '不完整的内容不应保存'
            raise httpx.RemoteProtocolError('incomplete chunked read')
        yield '完整总结'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
    assert calls[1] == calls[2] and calls.count(calls[0]) == 1
    assert repo.background_task(task_id)['status'] == 'completed'
    with repo.connect() as connection:
        contents = connection.execute('SELECT content FROM summary_checkpoints').fetchall()
    assert all('不完整' not in row[0] for row in contents)


def test_transport_retries_are_bounded_and_auth_failure_is_not_retried(setup, no_retry_delay):
    import httpx
    from reader_next_api.summary_tasks import stream_block
    repo, doc, options, task_id = setup
    attempts = []
    async def disconnected(*args, **kwargs):
        attempts.append(1)
        raise httpx.RemoteProtocolError('truncated')
        yield ''
    with pytest.raises(RuntimeError, match='自动重试2次'):
        finish(stream_block(SimpleNamespace(stream=disconnected), repo.profile('model'), 'key', 'source', 'prompt', lambda: None, lambda _: None))
    assert len(attempts) == 3
    attempts.clear()
    async def unauthorized(*args, **kwargs):
        attempts.append(1)
        response = httpx.Response(401, request=httpx.Request('POST', 'https://example.com'))
        raise httpx.HTTPStatusError('unauthorized', request=response.request, response=response)
        yield ''
    with pytest.raises(httpx.HTTPStatusError):
        finish(stream_block(SimpleNamespace(stream=unauthorized), repo.profile('model'), 'key', 'source', 'prompt', lambda: None, lambda _: None))
    assert len(attempts) == 1


def test_pause_during_retry_backoff_stops_further_calls(setup, no_retry_delay):
    import httpx
    from reader_next_api.summary_tasks import stream_block
    repo, doc, options, task_id = setup
    attempts = []
    paused = False
    def check():
        if paused:
            raise SummaryStopped()
    def progress(_):
        nonlocal paused
        paused = True
    async def stream(*args, **kwargs):
        attempts.append(1)
        raise httpx.RemoteProtocolError('truncated')
        yield ''
    with pytest.raises(SummaryStopped):
        finish(stream_block(SimpleNamespace(stream=stream), repo.profile('model'), 'key', 'source', 'prompt', check, progress))
    assert len(attempts) == 1


@pytest.mark.parametrize('reason,expected_calls', [('server_error', 2), ('content_filter', 1), ('unknown', 1)])
def test_incomplete_response_retry_classification(setup, no_retry_delay, reason, expected_calls):
    from reader_next_api.summary_tasks import stream_block
    from reader_next_api.providers import IncompleteModelResponse
    repo, _, _, _ = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise IncompleteModelResponse({'id': 'resp-example', 'incomplete_details': {'reason': reason}})
        yield '完整正文'
    coroutine = stream_block(SimpleNamespace(stream=stream), repo.profile('model'), 'key', 'source', 'prompt', lambda: None, lambda _: None)
    if reason == 'server_error':
        assert finish(coroutine) == '完整正文'
    else:
        with pytest.raises(IncompleteModelResponse):
            finish(coroutine)
    assert len(calls) == expected_calls


def test_burst_waits_and_retries_without_reusing_partial_attempt(setup, monkeypatch):
    from reader_next_api import summary_tasks
    from reader_next_api.providers import ModelRateLimitError
    sleeps = []
    async def sleep(seconds):
        sleeps.append(seconds)
    monkeypatch.setattr(summary_tasks.asyncio, 'sleep', sleep)
    repo, _, _, _ = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(1)
        if len(calls) < 3:
            yield '残缺'
            raise ModelRateLimitError()
        yield '完整'
    messages = []
    result = finish(summary_tasks.stream_block(SimpleNamespace(stream=stream), repo.profile('model'), 'key', 'source', 'prompt', lambda: None, messages.append))
    assert result == '完整' and len(calls) == 3
    assert sum(sleeps) == 90
    assert any('30秒' in message for message in messages)
    assert any('60秒' in message for message in messages)


def test_server_retry_after_is_respected_and_retries_are_bounded(setup, monkeypatch):
    from reader_next_api import summary_tasks
    from reader_next_api.providers import ModelRateLimitError
    sleeps = []
    async def sleep(seconds):
        sleeps.append(seconds)
    monkeypatch.setattr(summary_tasks.asyncio, 'sleep', sleep)
    repo, _, _, _ = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(1)
        raise ModelRateLimitError(90)
        yield ''
    with pytest.raises(RuntimeError, match='至少等待120秒'):
        finish(summary_tasks.stream_block(SimpleNamespace(stream=stream), repo.profile('model'), 'key', 'source', 'prompt', lambda: None, lambda _: None))
    assert len(calls) == 3 and sum(sleeps) == 180


def test_pacer_enforces_interval_and_shared_cooldown_without_real_sleep():
    from reader_next_api.summary_tasks import SummaryPacer
    now = [100.0]
    sleeps = []
    async def sleep(seconds):
        sleeps.append(seconds)
        now[0] += seconds
    pacer = SummaryPacer(clock=lambda: now[0], sleep=sleep)
    finish(pacer.wait(lambda: None, lambda _: None))
    finish(pacer.wait(lambda: None, lambda _: None))
    assert sum(sleeps) == 3
    pacer.defer(60)
    finish(pacer.wait(lambda: None, lambda _: None))
    assert now[0] == 163
    pacer.defer(300)
    with pytest.raises(RuntimeError, match='冷却期'):
        finish(pacer.wait(lambda: None, lambda _: None))


def test_cancel_during_rate_limit_wait_stops_requests(setup, monkeypatch):
    from reader_next_api import summary_tasks
    from reader_next_api.providers import ModelRateLimitError
    stopped = [False]
    async def sleep(seconds):
        stopped[0] = True
    monkeypatch.setattr(summary_tasks.asyncio, 'sleep', sleep)
    def check():
        if stopped[0]:
            raise SummaryStopped()
    calls = []
    async def stream(*args, **kwargs):
        calls.append(1)
        raise ModelRateLimitError()
        yield ''
    repo, _, _, _ = setup
    with pytest.raises(SummaryStopped):
        finish(summary_tasks.stream_block(SimpleNamespace(stream=stream), repo.profile('model'), 'key', 'source', 'prompt', check, lambda _: None))
    assert len(calls) == 1


def test_content_filter_skips_only_affected_chapter_and_marks_partial_result(setup):
    from reader_next_api.providers import ModelContentFilterError
    repo, doc, options, task_id = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        if '概念二。' in kwargs['excerpt']:
            raise ModelContentFilterError()
        yield '已验证的可用总结〔PDF 1〕'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
    task = repo.background_task(task_id)
    assert task['status'] == 'partial' and task['progress'] == task['total'] == 4
    missing = task['result']['missing_chapters']
    assert len(missing) == 1 and missing[0]['title'] == '小章二'
    assert sum('概念二。' in text for text in calls) == 1
    saved = {item['chapter_key']: item for item in repo.list_chapter_summaries(doc)}
    assert chapter_key(doc, options['outline'], 2) not in saved
    assert '小章二' in saved[f'{doc}:__book__']['content']
    assert saved[chapter_key(doc, options['outline'], 0)]['content'].startswith('【总结不完整')
    assert all('待补充清单' not in text for text in calls)
    assert Repository(repo.database_path.parent).list_summary_gaps(doc)[0]['title'] == '小章二'
    repo.clear_finished_background_tasks()
    assert repo.list_summary_gaps(doc)  # clearing history must not hide missing coverage


def test_manually_supplied_chapter_clears_gap_and_rebuilds_partial_parents(setup):
    from reader_next_api.providers import ModelContentFilterError
    repo, doc, options, task_id = setup
    async def blocked(*args, **kwargs):
        if '概念二。' in kwargs['excerpt']:
            raise ModelContentFilterError()
        yield '可用总结'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=blocked), SimpleNamespace(get=lambda _: 'key')))
    repo.import_learning_structure(doc, options['outline'], [{
        'chapter_key': f'{doc}:2', 'title': '小章二', 'start_page': 2, 'end_page': 2, 'depth': 1, 'content': '人工补充总结',
    }])
    assert repo.list_summary_gaps(doc) == []
    calls = []
    async def success(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        yield '完整汇总'
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=success), SimpleNamespace(get=lambda _: 'key')))
    assert repo.background_task(task_id)['status'] == 'completed'
    saved = {item['chapter_key']: item for item in repo.list_chapter_summaries(doc)}
    assert not saved[chapter_key(doc, options['outline'], 0)]['content'].startswith('【总结不完整')
    assert not saved[f'{doc}:__book__']['content'].startswith('【总结不完整')
    assert any('人工补充总结' in text for text in calls)
    assert all('概念二。' not in text for text in calls)


def test_all_chapters_blocked_does_not_invent_a_book_summary(setup):
    from reader_next_api.providers import ModelContentFilterError
    repo, doc, options, task_id = setup
    calls = []
    async def stream(*args, **kwargs):
        calls.append(kwargs['excerpt'])
        raise ModelContentFilterError()
        yield ''
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
    assert len(calls) == 2  # Only the two original leaves; no model calls with empty evidence.
    task = repo.background_task(task_id)
    assert task['status'] == 'partial' and '暂无可用' in task['message']
    book = next(item for item in repo.list_chapter_summaries(doc) if item['chapter_key'].endswith(':__book__'))
    assert book['content'].startswith('【总结不完整')
    assert '小章一' in book['content'] and '小章二' in book['content']


def test_unrelated_http_400_is_not_skipped(setup):
    import httpx
    repo, doc, options, task_id = setup
    async def stream(*args, **kwargs):
        request = httpx.Request('POST', 'https://example.com')
        raise httpx.HTTPStatusError('invalid parameter', request=request, response=httpx.Response(400, request=request))
        yield ''
    with pytest.raises(httpx.HTTPStatusError):
        finish(run_summary(repo, task_id, options, SimpleNamespace(stream=stream), SimpleNamespace(get=lambda _: 'key')))
    assert repo.list_summary_gaps(doc) == []
    assert repo.list_chapter_summaries(doc) == []


def test_gap_is_cleared_with_document_and_existing_summary_is_preserved(setup):
    from reader_next_api.providers import ModelContentFilterError
    repo, doc, options, task_id = setup
    options['chapter_index'] = 2
    repo.save_chapter_summary(doc, f'{doc}:2', '小章二', 2, 2, 1, '已有总结')
    async def blocked(*args, **kwargs):
        raise ModelContentFilterError()
        yield ''
    finish(run_summary(repo, task_id, options, SimpleNamespace(stream=blocked), SimpleNamespace(get=lambda _: 'key')))
    assert repo.list_chapter_summaries(doc)[0]['content'] == '已有总结'
    assert repo.background_task(task_id)['status'] == 'partial'
    repo.delete_document(doc)
    with repo.connect() as connection:
        assert connection.execute('SELECT count(*) FROM summary_gaps').fetchone()[0] == 0


def test_direct_manual_save_resolves_gap_without_changing_outline(setup):
    repo, doc, _, _ = setup
    repo.save_summary_gap(doc, f'{doc}:2', '小章二', 2, 2, '内容审核')
    before = repo.get_imported_outline(doc)
    repo.save_chapter_summary(doc, f'{doc}:2', '小章二', 2, 2, 1, '人工总结正文')
    assert repo.list_summary_gaps(doc) == []
    assert repo.get_imported_outline(doc) == before
