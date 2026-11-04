"""Android composition. All storage/credentials are supplied by the app sandbox."""
import http.cookiejar
import json
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import urllib.request

import uvicorn


if sys.platform == 'android' or hasattr(sys, 'getandroidapilevel'):
    from java.android.importer import AssetFinder

    # Flet wheels keep linked libraries in opt/lib. Let Chaquopy's native
    # loader extract and load them by SONAME alongside its own libraries.
    _find_chaquopy_library = AssetFinder.find_lib

    def _find_android_library(finder, filename):
        wheel_path = f'opt/lib/{filename}'
        if finder.exists(wheel_path):
            finder.extract_if_changed(wheel_path)
            return str(Path(finder.extract_root) / wheel_path)
        return _find_chaquopy_library(finder, filename)

    AssetFinder.find_lib = _find_android_library


from .application import create_app
from .android_embeddings import AndroidEmbeddings
from .embedding_models import BUILTIN_ID
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
    from base64 import b64decode
    from io import BytesIO

    import numpy as np
    import onnxruntime
    from PIL import Image
    from tokenizers import Tokenizer
    from tokenizers.models import WordLevel

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
        catalog = json.load(response)
        result['builtin_retrieval'] = catalog['active_id'] == BUILTIN_ID
        result['embedding_presets'] = len(catalog['presets'])
    image = BytesIO()
    Image.new('RGB', (2, 2), (50, 60, 70)).save(image, 'PNG')
    result['image_decoder'] = Image.open(image).getpixel((0, 0)) == (50, 60, 70)
    tokenizer = Tokenizer(WordLevel({'[UNK]': 0, '测试': 1}, unk_token='[UNK]'))
    # ONNX opset 13 Identity model accepting a two-element float tensor.
    model = b64decode('CAg6QwoQCgF4EgF5IghJZGVudGl0eRINYW5kcm9pZF9wcm9iZVoPCgF4EgoKCAgBEgQKAggCYg8KAXkSCgoICAESBAoCCAJCAhAN')
    options = onnxruntime.SessionOptions()
    options.intra_op_num_threads = 1
    session = onnxruntime.InferenceSession(model, options, providers=['CPUExecutionProvider'])
    output = session.run(None, {'x': np.asarray(tokenizer.encode('测试').ids + [2], dtype=np.float32)})
    result['native_embeddings'] = output[0].tolist() == [1, 2]
    return json.dumps(result)
