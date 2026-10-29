import socket
import sys

import pytest
from fastapi.testclient import TestClient

from reader_next_api.desktop import DataLock, LocalServer, default_home, desktop_app, resource_paths


def test_desktop_default_data_and_frozen_resources_do_not_depend_on_install_dir(tmp_path, monkeypatch):
    monkeypatch.setenv('LOCALAPPDATA', str(tmp_path))
    assert default_home() == tmp_path / 'DubuTianxia/v2'
    monkeypatch.setattr(sys, 'frozen', True, raising=False)
    monkeypatch.setattr(sys, '_MEIPASS', str(tmp_path / 'bundle'), raising=False)
    assert resource_paths() == (tmp_path / 'bundle/web', tmp_path / 'bundle/ocr')


def test_desktop_session_protects_api_static_files_and_cross_origin_requests(tmp_path):
    web = tmp_path / 'web'
    web.mkdir()
    (web / 'index.html').write_text('<h1>读步天下</h1>', encoding='utf-8')
    (web / 'worker.mjs').write_text('self.ok=true')
    ocr = tmp_path / 'ocr/tesseract.js/dist'
    ocr.mkdir(parents=True)
    (ocr / 'worker.min.js').write_text('worker')
    home = tmp_path / 'user'
    origin = 'http://127.0.0.1:8792'
    with TestClient(desktop_app(home, origin, 'session-secret', web, tmp_path / 'ocr'), base_url=origin) as client:
        assert client.get('/api/documents').status_code == 403
        assert client.get('/').status_code == 403
        assert client.get('/desktop-start/wrong').status_code == 403
        assert client.post('/desktop-start/session-secret').status_code == 403
        response = client.get('/desktop-start/session-secret', follow_redirects=False)
        assert response.status_code == 303
        assert response.headers['cache-control'] == 'no-store'
        assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
        assert '读步天下' in client.get('/').text
        assert client.get('/worker.mjs').headers['content-type'].startswith('application/javascript')
        assert client.get('/api/health').json() == {'status': 'ok'}
        assert client.get('/api/documents').json() == {'documents': []}
        assert client.get('/api/ocr/assets/worker.min.js').text == 'worker'
        assert client.get('/api/health', headers={'Origin': 'http://evil.example'}).status_code == 403
        assert client.get('/api/health', headers={'Host': 'evil.example:8792'}).status_code == 403
        assert client.get('/../credentials.json').status_code != 200
    assert (home / 'data').is_dir()


def test_missing_ui_refuses_to_initialize_user_data(tmp_path):
    with pytest.raises(RuntimeError, match='桌面资源缺失'):
        desktop_app(tmp_path / 'home', 'http://127.0.0.1:8792', 'secret', tmp_path, tmp_path)
    assert not (tmp_path / 'home').exists()


def test_data_lock_rejects_duplicate_and_releases_after_exit(tmp_path):
    with DataLock(tmp_path):
        with pytest.raises(RuntimeError, match='已有桌面程序'):
            with DataLock(tmp_path):
                pytest.fail('duplicate lock acquired')
    with DataLock(tmp_path):
        pass


def test_desktop_port_collision_never_attaches_to_or_stops_another_server():
    with socket.socket() as occupied:
        occupied.bind(('127.0.0.1', 0))
        occupied.listen()
        port = occupied.getsockname()[1]
        with pytest.raises(RuntimeError, match='已被占用'):
            LocalServer(None, port)
        assert occupied.getsockname()[1] == port
