from __future__ import annotations

import asyncio
import shutil
import sqlite3
import zipfile
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..full_backup import MAX_ARCHIVE_BYTES, create_full_backup, inspect_backup


from ..runtime import Runtime
from ..book_backup import MAX_ARCHIVE, create_book_backup, inspect_book_backup, install_book_backup


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    def _remove_backup_file(path: Path) -> None:
        path.unlink(missing_ok=True)

    @router.get('/api/backup/full')
    def download_full_backup() -> FileResponse:
        export_path = runtime.data_root / f'.reader-next-backup-{uuid4().hex}.zip'
        try:
            create_full_backup(runtime.data_root, export_path)
        except Exception as error:
            export_path.unlink(missing_ok=True)
            raise HTTPException(500, f'完整备份创建失败：{error}') from error
        stamp = __import__('datetime').datetime.now().strftime('%Y-%m-%d-%H%M')
        filename = f'reader-next-full-{stamp}.zip'
        return FileResponse(export_path, media_type='application/zip', filename=filename, background=BackgroundTask(_remove_backup_file, export_path))

    @router.post('/api/backup/restore')
    async def restore_full_backup(file: UploadFile=File(...)) -> dict:
        if not file.filename or not file.filename.lower().endswith('.zip'):
            raise HTTPException(400, '请选择 Reader Next 完整备份 ZIP 文件。')
        upload_path = runtime.data_root / f'.restore-upload-{uuid4().hex}.zip'
        staging_path = runtime.data_root / f'.restore-stage-{uuid4().hex}'
        safety_path = runtime.data_root / 'backups' / f'pre-restore-{uuid4().hex}.zip'
        received = 0
        try:
            with upload_path.open('wb') as destination:
                while (chunk := (await file.read(1024 * 1024))):
                    received += len(chunk)
                    if received > MAX_ARCHIVE_BYTES:
                        raise HTTPException(413, '备份文件超过 12GB 安全限制。')
                    destination.write(chunk)
            manifest = await asyncio.to_thread(inspect_backup, upload_path, staging_path)
            counts, safety = await asyncio.to_thread(runtime.restore, staging_path, safety_path)
            return {'ok': True, 'created_at': manifest.get('created_at'), 'counts': counts, 'safety_backup': safety_path.name, 'credentials_restored': False, 'message': '完整备份已恢复。API Key 出于安全原因未包含在备份中，请按需重新填写。'}
        except HTTPException:
            raise
        except (ValueError, zipfile.BadZipFile) as error:
            raise HTTPException(400, str(error)) from error
        except Exception as error:
            raise HTTPException(500, f'完整备份恢复失败：{error}') from error
        finally:
            await file.close()
            upload_path.unlink(missing_ok=True)
            if staging_path.exists():
                shutil.rmtree(staging_path, ignore_errors=True)

    @router.get('/api/backup/book/{document_id}')
    def download_book_backup(document_id: str, summary_profile_id: str | None=None):
        if runtime.task_manager.book_busy(document_id):
            raise HTTPException(409, '该书仍有后台任务，请暂停并等待当前调用结束后导出。')
        destination = runtime.data_root / f'.book-export-{uuid4().hex}.zip'
        try:
            create_book_backup(runtime.repository, document_id, destination, summary_profile_id=summary_profile_id)
            return FileResponse(destination, media_type='application/zip', filename=f'reader-next-book-{document_id}.zip',
                                background=BackgroundTask(_remove_backup_file, destination))
        except Exception as error:
            destination.unlink(missing_ok=True)
            if isinstance(error, LookupError):
                raise HTTPException(404, str(error)) from error
            if isinstance(error, ValueError):
                raise HTTPException(400, str(error)) from error
            raise

    @router.post('/api/backup/book')
    async def import_book_backup(file: UploadFile=File(...), replace_existing: bool=Form(False)):
        upload = runtime.data_root / f'.book-upload-{uuid4().hex}.zip'
        staging = runtime.data_root / f'.book-stage-{uuid4().hex}'
        try:
            received = 0
            with upload.open('wb') as destination:
                while chunk := await file.read(1024 * 1024):
                    received += len(chunk)
                    if received > MAX_ARCHIVE:
                        raise HTTPException(413, '单书备份ZIP不得超过1GB。')
                    destination.write(chunk)
            data = await asyncio.to_thread(inspect_book_backup, upload, staging)
            existing = next((doc for doc in runtime.repository.list_documents() if doc["sha256"] == data["document"]["sha256"]), None)
            if existing:
                if runtime.task_manager.book_busy(existing["id"]):
                    raise HTTPException(409, '相同教材仍有后台任务，请暂停并等待当前调用结束后导入。')
                if not replace_existing:
                    raise HTTPException(409, '相同PDF已存在，导入会替换该书学习数据，请确认后重试。')
            return await asyncio.to_thread(install_book_backup, runtime.repository, data, staging / "document.pdf", replace_existing=replace_existing)
        except HTTPException:
            raise
        except OSError as error:
            raise HTTPException(500, '单书文件读写失败，请检查磁盘空间和目录权限。') from error
        except (ValueError, KeyError, TypeError, AttributeError, sqlite3.Error, zipfile.BadZipFile) as error:
            raise HTTPException(400, f'单书备份无效或导入失败：{error}') from error
        finally:
            await file.close()
            upload.unlink(missing_ok=True)
            if staging.exists():
                shutil.rmtree(staging, ignore_errors=True)

    @router.get('/api/export')
    def export_data() -> dict:
        return {'version': 1, 'data': runtime.repository.export_data()}

    return router
