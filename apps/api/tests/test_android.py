import json

import pytest
from fastapi.testclient import TestClient

from reader_next_api.android_backend import AndroidCredentials, android_repository
from reader_next_api.application import create_app
from reader_next_api.embedding_models import BUILTIN_ID, PRESETS
from reader_next_api.runtime import Runtime


class Vault:
    def __init__(self): self.values = {}
    def get(self, key): return self.values.get(key)
    def set(self, key, value): self.values[key] = value
    def delete(self, key): self.values.pop(key, None)


def test_android_credentials_use_injected_keystore_and_fail_closed():
    vault = Vault()
    credentials = AndroidCredentials(vault)
    assert credentials.set('test', '  test-only-secret  ') == 'android-keystore'
    assert credentials.get('test') == 'test-only-secret'
    credentials.delete('test')
    assert credentials.get('test') is None
    def fail(*args): raise RuntimeError('keystore unavailable')
    vault.set = fail
    with pytest.raises(RuntimeError, match='keystore unavailable'):
        credentials.set('test', 'test-only-secret')
    assert not vault.values


def test_android_restored_desktop_model_metadata_is_preserved_but_retrieval_uses_builtin(tmp_path):
    tmp_path.mkdir(exist_ok=True)
    metadata = {'active_id': 'desktop-fastembed', 'models': [{'id': 'desktop-fastembed', 'model_name': 'unavailable-desktop', 'engine': 'fastembed'}]}
    config = tmp_path / 'embedding-models.json'
    config.write_text(json.dumps(metadata))
    repo = android_repository(tmp_path)
    assert repo.embedding_models.active()['id'] == BUILTIN_ID
    assert json.loads(config.read_text()) == metadata
    catalog = repo.list_embedding_models()
    assert [item['model_name'] for item in catalog['presets']] == [item['model_name'] for item in PRESETS]
    assert [item['id'] for item in catalog['models']] == [BUILTIN_ID]
    assert catalog['active_id'] == BUILTIN_ID
    with pytest.raises(ValueError, match='安卓'):
        repo.select_embedding_model('desktop-fastembed')


def test_android_runtime_uses_private_store_and_supported_retrieval(tmp_path):
    vault = Vault()
    runtime = Runtime(tmp_path / 'data', tmp_path / 'ocr', credential_store=AndroidCredentials(vault), repository_factory=android_repository)
    with TestClient(create_app(runtime=runtime)) as client:
        assert client.get('/api/health').json() == {'status': 'ok'}
        assert len(client.get('/api/embedding-models').json()['presets']) == 2
        assert runtime.credential_store.vault is vault
        runtime.credential_store.set('profile', 'not-a-real-key')
    assert not (tmp_path / 'data/credentials.json').exists()
