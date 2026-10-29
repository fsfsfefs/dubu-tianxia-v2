"""Windows desktop composition; no data or GUI work happens on import."""
from __future__ import annotations

import argparse
import ctypes
import http.cookiejar
import json
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import sys
import threading
import time
import urllib.request

import uvicorn
from fastapi.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles

from .application import create_app
from .runtime import Runtime


def default_home() -> Path:
    return Path(os.environ['LOCALAPPDATA']) / 'DubuTianxia' / 'v2'


def resource_paths() -> tuple[Path, Path]:
    if getattr(sys, 'frozen', False):
        resources = Path(sys._MEIPASS)
        return resources / 'web', resources / 'ocr'
    root = Path(__file__).resolve().parents[3]
    return root / 'apps/web/dist', root / 'apps/web/node_modules'


class DataLock:
    """OS releases the lock on exit/crash; never unlink a live lock file."""
    def __init__(self, home: Path):
        self.path = home / 'desktop.lock'
        self.file = None

    def __enter__(self):
        import msvcrt
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = self.path.open('a+b')
        self.file.seek(0, 2)
        if self.file.tell() == 0:
            self.file.write(b'0')
            self.file.flush()
        self.file.seek(0)
        try:
            msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError:
            self.file.close()
            self.file = None
            raise RuntimeError('该数据目录已有桌面程序运行，请切回已打开的窗口。') from None
        return self

    def __exit__(self, *_):
        import msvcrt
        if self.file:
            self.file.seek(0)
            msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()


class DesktopAccess:
    """Keep the bundled HTTP API private to the desktop browser session."""
    def __init__(self, app, origin: str, token: str):
        self.app, self.origin, self.token = app, origin, token

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = dict(scope['headers'])
        host = headers.get(b'host', b'').decode('latin1')
        origin = headers.get(b'origin', b'').decode('latin1')
        cookie = headers.get(b'cookie', b'').decode('latin1')
        valid_cookie = any(part.strip() == f'dubu_session={self.token}' for part in cookie.split(';'))
        if host != self.origin.removeprefix('http://') or (origin and origin != self.origin):
            return await Response(status_code=403)(scope, receive, send)
        bootstrap = scope['path'] == f'/desktop-start/{self.token}' and scope['method'] == 'GET'
        if bootstrap:
            response = RedirectResponse('/', status_code=303)
            response.set_cookie('dubu_session', self.token, httponly=True, samesite='strict')
            response.headers['Cache-Control'] = 'no-store'
            return await response(scope, receive, send)
        if not valid_cookie:
            return await Response(status_code=403)(scope, receive, send)
        await self.app(scope, receive, send)


def desktop_app(home: Path, origin: str, token: str, web: Path, ocr: Path):
    if not (web / 'index.html').is_file():
        raise RuntimeError('桌面资源缺失，请重新解压完整程序目录。开发运行前请先构建前端。')
    mimetypes.add_type('application/javascript', '.mjs')
    mimetypes.add_type('application/wasm', '.wasm')
    app = create_app(runtime=Runtime(home / 'data', ocr))
    app.mount('/', StaticFiles(directory=web, html=True), name='desktop-ui')
    app.add_middleware(DesktopAccess, origin=origin, token=token)
    return app


class LocalServer:
    def __init__(self, app, port: int):
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        try:
            self.socket.bind(('127.0.0.1', port))
            self.socket.listen(128)
        except OSError:
            self.socket.close()
            raise RuntimeError(f'桌面端口 {port} 已被占用，未停止任何其他程序。请关闭冲突程序后重试。') from None
        self.server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port,
            log_config=None, access_log=False, log_level='critical', loop='asyncio',
            http='h11', ws='none', timeout_graceful_shutdown=5))
        self.thread = threading.Thread(target=self.server.run, kwargs={'sockets': [self.socket]}, daemon=True)

    def start(self):
        self.thread.start()
        deadline = time.monotonic() + 45
        while not self.server.started:
            if not self.thread.is_alive() or time.monotonic() > deadline:
                self.stop()
                raise RuntimeError('本地服务启动失败。请检查数据目录权限和数据库版本。')
            time.sleep(.05)

    def stop(self):
        self.server.should_exit = True
        if self.thread.is_alive():
            # Keep DataLock until lifespan/task shutdown really finishes.
            self.thread.join()
        self.socket.close()


def run(args):
    import webview
    home = Path(args.data_dir).expanduser().resolve() if args.data_dir else default_home()
    os.environ.setdefault('HF_HOME', str(home / 'data/embedding-models/hf-cache'))
    web, ocr = resource_paths()
    token = secrets.token_urlsafe(32)
    origin = f'http://127.0.0.1:{args.port}'
    with DataLock(home):
        server = LocalServer(desktop_app(home, origin, token, web, ocr), args.port)
        try:
            server.start()
            webview.settings['ALLOW_DOWNLOADS'] = True
            webview.settings['OPEN_EXTERNAL_LINKS_IN_BROWSER'] = True
            window = webview.create_window('读步天下 · 第二版', f'{origin}/desktop-start/{token}',
                width=1100, height=640, maximized=True, min_size=(800, 600), text_select=True,
                confirm_close=not args.smoke_test, background_color='#f7f6ef')
            result = {}

            def smoke():
                # Exercise the frozen native renderer, API, OCR and optional native vector runtime.
                try:
                    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                    opener.open(f'{origin}/desktop-start/{token}').close()
                    for path in ('/api/health', '/api/documents', '/api/ocr/assets/worker.min.js',
                                 '/api/ocr/assets/core/tesseract-core-lstm.wasm',
                                 '/api/ocr/assets/lang/chi_sim.traineddata.gz'):
                        with opener.open(origin + path) as response:
                            result[path] = response.status
                    from fastembed import TextEmbedding
                    import onnxruntime
                    result['vector_runtime'] = bool(TextEmbedding.list_supported_models()) and bool(onnxruntime.get_available_providers())
                    deadline = time.monotonic() + 30
                    while time.monotonic() < deadline:
                        if window.evaluate_js("Boolean(document.querySelector('button') && document.body.innerText.includes('使用指南'))"):
                            result['native_ui'] = True
                            break
                        time.sleep(.2)
                    if not result.get('native_ui'):
                        raise RuntimeError('Native frontend did not become ready')
                except Exception as error:
                    result['error'] = type(error).__name__
                finally:
                    Path(args.smoke_report).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
                    window.destroy()

            webview.start(smoke if args.smoke_test else None, gui='edgechromium', debug=False,
                private_mode=False, storage_path=str(home / 'webview'),
                localization={'global.quitConfirmation': '退出读步天下？后台任务将停止，已完成分块会保留，重启后可在任务中心继续。'})
            if args.smoke_test and (result.get('error') or not result.get('native_ui')):
                raise RuntimeError('桌面冒烟验证失败，请检查报告。')
        finally:
            server.stop()


def main():
    parser = argparse.ArgumentParser(description='读步天下 Windows 桌面版')
    parser.add_argument('--data-dir', help='桌面用户目录，包含 data 和 webview；默认 LOCALAPPDATA/DubuTianxia/v2')
    parser.add_argument('--port', type=int, default=8792)
    parser.add_argument('--smoke-test', action='store_true', help='隔离验收模式；启动真实窗口后自动退出')
    parser.add_argument('--smoke-report')
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')
    if args.smoke_test and (not args.data_dir or not args.smoke_report):
        parser.error('smoke-test requires explicit data-dir and smoke-report')
    try:
        run(args)
    except Exception as error:
        if args.smoke_test:
            Path(args.smoke_report).write_text(json.dumps({'error': type(error).__name__, 'detail': str(error)}, ensure_ascii=False), encoding='utf-8')
            return 1
        ctypes.windll.user32.MessageBoxW(None, f'{error}\n\n需要 Windows 10/11 x64 和 Microsoft Edge WebView2 Runtime。', '读步天下启动失败', 0x10)
        return 1
    return 0
