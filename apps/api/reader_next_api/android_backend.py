"""Android composition. All storage/credentials are supplied by the app sandbox."""
import http.cookiejar
import json
from pathlib import Path
import secrets
import socket
import threading
import time
import urllib.request

import uvicorn

from .application import create_app
from .embedding_models import BUILTIN_ID, EmbeddingModelManager
from .local_ui import attach_local_ui
from .repository import Repository
from .runtime import Runtime


class AndroidCredentials:
    """Fail closed on Keystore errors; never fall back to a plaintext key file."""
    def __init__(self, vault):
        self.vault = vault

    def get(self, profile_id):
        return self.vault.get(profile_id) or None

    def set(self, profile_id, api_key):
        value = api_key.strip()
        if not value:
            raise ValueError('API Key 不能为空。')
        self.vault.set(profile_id, value)
        return 'android-keystore'

    def delete(self, profile_id):
        self.vault.delete(profile_id)


class AndroidEmbeddings(EmbeddingModelManager):
    # Desktop model metadata/files survive backup round trips. Android builds
    # vectors with its builtin model without silently rewriting that metadata.
    def active(self):
        return self.builtin()

    def list_models(self):
        return {'active_id': BUILTIN_ID, 'models': [self.builtin()], 'presets': [],
                'external_models_supported': False,
                'platform_note': '安卓单机版使用离线轻量检索；暂不支持桌面 FastEmbed 模型。在线聊天模型可正常配置。'}

    def select(self, model_id):
        if model_id != BUILTIN_ID:
            raise ValueError('安卓版本暂不支持 FastEmbed 模型。')
        return self.builtin()

    def install_download(self, model_name):
        raise ValueError('安卓版本暂不支持 FastEmbed 模型下载。')

    def install_archive(self, name, model_name, payload):
        raise ValueError('安卓版本暂不支持 FastEmbed 模型导入。')


def android_repository(root):
    return Repository(root, embedding_models_factory=AndroidEmbeddings)


class AndroidServer:
    def __init__(self, home, assets, vault, port=18894):
        self.token = secrets.token_urlsafe(32)
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.socket.bind(('127.0.0.1', port))
        self.socket.listen(128)
        self.origin = f'http://127.0.0.1:{self.socket.getsockname()[1]}'
        try:
            runtime = Runtime(Path(home), Path(assets) / 'ocr', credential_store=AndroidCredentials(vault), repository_factory=android_repository)
            app = attach_local_ui(create_app(runtime=runtime), Path(assets) / 'web', self.origin, self.token)
            self.server = uvicorn.Server(uvicorn.Config(app, log_config=None, access_log=False,
                log_level='critical', loop='asyncio', http='h11', ws='none'))
            self.thread = threading.Thread(target=self.server.run, kwargs={'sockets': [self.socket]}, daemon=True)
        except BaseException:
            self.socket.close()
            raise

    def start(self):
        self.thread.start()
        deadline = time.monotonic() + 60
        while not self.server.started:
            if not self.thread.is_alive() or time.monotonic() > deadline:
                self.stop()
                raise RuntimeError('平板本地服务启动失败，请保留应用数据并反馈问题。')
            time.sleep(.05)
        return self.origin + '/desktop-start/' + self.token

    def stop(self):
        self.server.should_exit = True
        if self.thread.is_alive():
            self.thread.join()
        self.socket.close()


_session = None
_lock = threading.Lock()


def start(home, assets, vault):
    global _session
    with _lock:
        if _session is None:
            pending = AndroidServer(home, assets, vault)
            try:
                url = pending.start()
            except BaseException:
                pending.stop()
                raise
            _session = pending
            return url
        return _session.origin + '/desktop-start/' + _session.token


def stop():
    global _session
    with _lock:
        if _session:
            _session.stop()
            _session = None


def probe():
    """Read-only instrumentation evidence; not exposed to JavaScript or HTTP."""
    if _session is None:
        raise RuntimeError('server not ready')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    opener.open(_session.origin + '/desktop-start/' + _session.token).close()
    result = {}
    for path in ('/api/health', '/api/documents', '/api/ocr/assets/worker.min.js',
                 '/api/ocr/assets/core/tesseract-core-lstm.wasm', '/api/ocr/assets/lang/chi_sim.traineddata.gz'):
        with opener.open(_session.origin + path) as response:
            result[path] = response.status
    with opener.open(_session.origin + '/api/embedding-models') as response:
        result['builtin_retrieval'] = json.load(response)['active_id'] == BUILTIN_ID
    return json.dumps(result)
