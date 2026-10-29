import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from reader_next_api import reading_agent as agent
from reader_next_api.schemas import ChatInput
from reader_next_api.application import create_app
from reader_next_api.runtime import Runtime
from reader_next_api.routes import chat as chat_routes
from reader_next_api.domain import ModelProfile
from reader_next_api.repository import Repository

PROFILE = ModelProfile('p', 'test', 'https://example.invalid/v1/chat/completions', 'test', max_tokens=8192)


def payload(**kwargs):
    return ChatInput(profile_id='p', document_id='a', document_ids=['a', 'b'],
                          question='比较两书的虚拟内存', use_rag=True, use_agent=True, **kwargs)


class Repo:
    def __init__(self):
        self.searches, self.reads, self.saved = [], [], []

    def profile(self, _):
        return PROFILE

    def list_documents(self):
        return [{'id': 'a', 'title': '教材甲'}, {'id': 'b', 'title': '教材乙'}]

    def rag_status_many(self, ids):
        assert ids == ['a', 'b']
        return {'indexed_pages': 10, 'chunk_count': 20}

    def search_rag_many(self, ids, query, limit):
        assert ids == ['a', 'b']
        self.searches.append(query)
        return [{'document_id': book, 'document_title': title, 'page_number': 10,
                 'content': f'{query}：虚拟内存结合内存和磁盘。', 'score': 1}
                for book, title in [('a', '教材甲'), ('b', '教材乙')]]

    def read_indexed_page(self, document_id, page):
        self.reads.append((document_id, page))
        return '相邻页详细解释了缺页中断。'

    def add_chat_message(self, *args):
        self.saved.append(args)


class Model:
    def __init__(self, plans=()):
        self.plans = list(plans)
        self.calls, self.answers = [], []

    async def complete(self, profile, key, *, system, prompt):
        self.calls.append((profile.max_tokens, system))
        if system == agent.PLANNER:
            return self.plans.pop(0) if self.plans else '{"done":true}'
        return '{"checks":[]}'

    async def stream(self, profile, key, **kwargs):
        self.answers.append(kwargs)
        yield '虚拟内存结合内存和磁盘。[教材甲｜PDF第10页]'


async def no_web(_):
    raise AssertionError('未勾选联网时不能调用网络检索')


def run(model=None, repo=None, request=None, web=no_web):
    model, repo = model or Model(), repo or Repo()

    async def collect():
        return [event async for event in agent.research_answer(request or payload(), repo, model, PROFILE, 'test', web)]
    return asyncio.run(collect()), model, repo


def test_agent_follows_missing_evidence_then_answers_and_verifies():
    plan = json.dumps({'queries': ['缺页中断'], 'pages': [{'document_id': 'a', 'page_number': 11}]})
    events, model, repo = run(Model([plan, '{"done":true}']))
    assert repo.searches == ['比较两书的虚拟内存', '缺页中断']
    assert repo.reads == [('a', 11)]
    sources = [event for event in events if event['type'] == 'sources'][-1]['sources']
    assert {s['document_id'] for s in sources} == {'a', 'b'}
    assert '缺页中断' in model.answers[0]['rag_context']
    assert any(event['type'] == 'citation_verification' for event in events)
    assert events[-1]['type'] == 'complete'
    assert len(model.calls) + len(model.answers) == 4
    assert [call[0] for call in model.calls] == [1024, 1024, 2048]
    assert model.answers[0]['max_tokens'] == 4096
    assert repo.saved[0][1] == 'assistant'


def test_out_of_scope_and_invented_pages_are_not_read():
    plans = [json.dumps({'pages': [{'document_id': 'secret', 'page_number': 10},
                                  {'document_id': 'a', 'page_number': 900}]})]
    _, _, repo = run(Model(plans))
    assert repo.reads == []


def test_duplicate_queries_stop_without_extra_rounds():
    events, model, repo = run(Model(['{"queries":["比较两书的虚拟内存"]}']))
    assert len(repo.searches) == 1
    assert len(model.calls) == 2  # One plan and one verification.
    assert events[-1]['type'] == 'complete'


@pytest.mark.parametrize('raw', ['not json', '[]', 'null', '```json\n[]\n```'])
def test_bad_plan_falls_back_to_existing_evidence(raw):
    events, model, _ = run(Model([raw]))
    assert any(event.get('stage') == 'fallback' for event in events)
    assert len(model.answers) == 1
    assert events[-1]['type'] == 'complete'


def test_no_unbounded_loop_and_no_unbounded_context():
    model = Model(['{"queries":["查询一","查询二","忽略"]}', '{"queries":["查询三","查询四"]}'])
    _, model, repo = run(model)
    assert len(repo.searches) == 5
    assert len(model.calls) + len(model.answers) <= 4
    assert '忽略' not in repo.searches

    class LargeRepo(Repo):
        def search_rag_many(self, ids, query, limit):
            return [{'document_id': 'a', 'document_title': '教材甲', 'page_number': n,
                     'content': '内存' * 5000, 'score': 1} for n in range(30)]

    events, _, _ = run(repo=LargeRepo())
    sources = next(e['sources'] for e in events if e['type'] == 'sources')
    assert sum(len(s['content']) for s in sources) <= agent.MAX_CONTEXT_CHARS
    assert len(sources) <= agent.MAX_SOURCES


def test_web_is_opt_in_and_network_failure_is_recoverable():
    calls = []

    async def search(query):
        calls.append(query)
        raise RuntimeError('network unavailable')

    events, _, _ = run(request=payload(use_web=True), web=search)
    assert len(calls) == 1
    assert any(e.get('stage') == 'fallback' for e in events)
    assert events[-1]['type'] == 'complete'


def test_cancellation_cancels_model_and_does_not_save_answer():
    async def scenario():
        started, cancelled = asyncio.Event(), asyncio.Event()

        class SlowModel(Model):
            async def complete(self, *args, **kwargs):
                started.set()
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()

        model, repo = SlowModel(), Repo()

        async def consume():
            async for _ in agent.research_answer(payload(), repo, model, PROFILE, 'test', no_web):
                pass

        task = asyncio.create_task(consume())
        await asyncio.wait_for(started.wait(), 2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert cancelled.is_set()
        assert model.answers == [] and repo.saved == []

    asyncio.run(scenario())


def test_planning_timeout_degrades_and_total_timeout_stops(monkeypatch):
    class SlowModel(Model):
        async def complete(self, profile, key, *, system, prompt):
            if system == agent.PLANNER:
                await asyncio.sleep(1)
            return '{"checks":[]}'

    monkeypatch.setattr(agent, 'STEP_TIMEOUT', 0.01)
    events, _, _ = run(SlowModel())
    assert any(e.get('stage') == 'fallback' for e in events)
    assert events[-1]['type'] == 'complete'
    monkeypatch.setattr(agent, 'TOTAL_TIMEOUT', 0.001)
    with pytest.raises(TimeoutError):
        run(SlowModel())


def test_api_agent_events_and_normal_mode_compatibility(monkeypatch):
    model, repo = Model(), Repo()
    runtime = Runtime(None, None)
    runtime.repository = repo
    runtime.provider = model
    runtime.credential_store = SimpleNamespace(get=lambda _: 'test')
    monkeypatch.setattr(chat_routes, 'search_professional_web_results', no_web)
    client = TestClient(create_app(runtime=runtime))
    response = client.post('/api/chat/stream', json=payload().model_dump())
    assert response.status_code == 200
    events = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith('data: ')]
    assert any(e['type'] == 'agent_progress' for e in events)
    assert events[-1]['type'] == 'complete'
    body = payload().model_dump()
    body['use_agent'] = False
    response = client.post('/api/chat/stream', json=body)
    assert 'agent_progress' not in response.text and '"type":"complete"' in response.text
    body.update(use_agent=True, use_rag=False)
    assert client.post('/api/chat/stream', json=body).status_code == 422


def test_page_context_reads_only_requested_page(tmp_path):
    repo = Repository(tmp_path)
    book = repo.add_document('book.pdf', b'%PDF-1.7\nfixture')
    repo.save_ocr_page(book['id'], 10, '甲' * 4000)
    repo.save_ocr_page(book['id'], 11, '乙')
    assert repo.read_indexed_page(book['id'], 10) == '甲' * 2400
    assert repo.read_indexed_page(book['id'], 12) == ''
    with pytest.raises(LookupError):
        repo.read_indexed_page('missing', 10)
