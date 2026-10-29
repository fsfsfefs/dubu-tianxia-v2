"""Composition root: configuration, resource lifecycle and feature routers."""
import asyncio
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.responses import JSONResponse

from .runtime import Runtime, MaintenanceBusy
from .routes import assets, documents, learning, models, tasks, chat, backup


class MaintenanceMiddleware:
    def __init__(self, app, runtime):
        self.app, self.runtime = app, runtime

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        exclusive = scope['path'] == '/api/backup/restore' and scope['method'] == 'POST'
        lease = self.runtime.lease(exclusive)
        try:
            lease.__enter__()
        except MaintenanceBusy:
            response = JSONResponse({'detail': '正在恢复备份或仍有请求运行，请稍后重试。'}, status_code=503)
            return await response(scope, receive, send)
        try:
            await self.app(scope, receive, send)
        finally:
            lease.__exit__(None, None, None)


def create_app(data_root=None, *, runtime=None):
    project_root = Path(__file__).resolve().parents[3]
    runtime = runtime or Runtime(Path(data_root or os.environ.get('READER_NEXT_DATA', project_root / '.data')),
                                 project_root / 'apps/web/node_modules')

    @asynccontextmanager
    async def lifespan(app):
        await asyncio.to_thread(runtime.start)
        try:
            yield
        finally:
            await asyncio.to_thread(runtime.stop)

    app = FastAPI(title='读步天下第二版 API', version='2.0.0', lifespan=lifespan)
    app.state.runtime = runtime
    app.add_middleware(MaintenanceMiddleware, runtime=runtime)
    app.add_middleware(CORSMiddleware, allow_origins=['http://127.0.0.1:5174', 'http://localhost:5174'],
                       allow_credentials=True, allow_methods=['*'], allow_headers=['*'])
    for module in (assets, documents, learning, models, tasks, chat, backup):
        app.include_router(module.create_router(runtime))
    return app
