from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from reader_next_api.routes.models import create_router
from reader_next_api.schemas import ProfileTestInput
from reader_next_api.domain import ModelProfile
from reader_next_api.repository import Repository


def finish(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coroutine.close()
    raise AssertionError('Mock unexpectedly suspended')


@pytest.fixture
def context(tmp_path, monkeypatch):
    repo = Repository(tmp_path)
    calls = []
    async def complete(profile, key, **kwargs):
        calls.append((profile, key))
        return 'OK'
    runtime = SimpleNamespace(repository=repo, provider=SimpleNamespace(complete=complete), credential_store=SimpleNamespace(get=lambda _: 'saved-key'))
    endpoint = next(r.endpoint for r in create_router(runtime).routes if r.name == 'test_model_draft')
    return repo, calls, runtime, endpoint


def test_unsaved_draft_uses_current_values_without_persistence(context):
    repo, calls, runtime, endpoint = context
    payload = ProfileTestInput(endpoint='https://example.com/v1', model='draft-model', api_key='temporary-key', max_tokens=8000)
    assert finish(endpoint(payload)) == {'ok': True, 'response': 'OK'}
    profile, key = calls[0]
    assert profile.endpoint == 'https://example.com/v1/chat/completions'
    assert profile.model == 'draft-model' and profile.max_tokens == 8000
    assert key == 'temporary-key'
    assert repo.list_profiles() == []


def test_edit_uses_draft_values_and_saved_key_without_changing_default(context):
    repo, calls, runtime, endpoint = context
    repo.save_profile(ModelProfile('saved', 'Saved', 'https://example.com/chat/completions', 'old', is_default=True))
    before = repo.list_profiles()
    payload = ProfileTestInput(id='saved', endpoint='https://example.com/responses', model='new', api_key='')
    finish(endpoint(payload))
    assert calls[0][0].model == 'new' and calls[0][0].endpoint.endswith('/responses')
    assert calls[0][1] == 'saved-key'
    assert repo.list_profiles() == before
    finish(endpoint(payload.model_copy(update={'api_key': 'replacement'})))
    assert calls[1][1] == 'replacement'
    assert repo.list_profiles() == before


def test_missing_key_and_invalid_draft_do_not_call_provider(context):
    _, calls, runtime, endpoint = context
    with pytest.raises(HTTPException) as error:
        finish(endpoint(ProfileTestInput(endpoint='https://example.com', model='new')))
    assert error.value.status_code == 409
    with pytest.raises(HTTPException) as error:
        finish(endpoint(ProfileTestInput(endpoint='bad-url', model='new', api_key='test')))
    assert error.value.status_code == 400
    assert calls == []


def test_provider_failure_is_reported_without_saving(context, monkeypatch):
    repo, _, runtime, endpoint = context
    async def fail(*args, **kwargs):
        raise RuntimeError('service unavailable')
    runtime.provider = SimpleNamespace(complete=fail)
    with pytest.raises(HTTPException) as error:
        finish(endpoint(ProfileTestInput(endpoint='https://example.com', model='new', api_key='test')))
    assert error.value.status_code == 502
    assert repo.list_profiles() == []
