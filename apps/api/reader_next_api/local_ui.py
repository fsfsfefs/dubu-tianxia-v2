"""Shared, same-origin UI boundary for packaged local applications."""
import mimetypes

from fastapi.responses import RedirectResponse, Response
from starlette.staticfiles import StaticFiles


class DesktopAccess:
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


def attach_local_ui(app, web, origin, token):
    if not (web / 'index.html').is_file():
        raise RuntimeError('应用界面资源缺失，请重新安装完整程序。')
    mimetypes.add_type('application/javascript', '.mjs')
    mimetypes.add_type('application/wasm', '.wasm')
    app.mount('/', StaticFiles(directory=web, html=True), name='local-ui')
    app.add_middleware(DesktopAccess, origin=origin, token=token)
    return app
