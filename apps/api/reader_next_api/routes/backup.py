from __future__ import annotations

import asyncio
import shutil
import zipfile
from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from ..full_backup import MAX_ARCHIVE_BYTES, create_full_backup, inspect_backup


from ..runtime import Runtime


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

    @router.get('/api/export')
    def export_data() -> dict:
        return {'version': 1, 'data': runtime.repository.export_data()}

    return router
