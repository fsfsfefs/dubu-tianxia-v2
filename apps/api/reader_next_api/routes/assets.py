from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse


from ..runtime import Runtime


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.get('/api/health')
    def health() -> dict:
        return {'status': 'ok'}

    def ocr_asset(path: Path, media_type: str | None=None) -> FileResponse:
        if not path.is_file():
            raise HTTPException(503, 'OCR 离线资源尚未安装，请在前端目录运行 npm install。')
        return FileResponse(path, media_type=media_type, headers={'Cache-Control': 'public, max-age=31536000, immutable'})

    @router.get('/api/ocr/assets/worker.min.js')
    def ocr_worker_asset() -> FileResponse:
        return ocr_asset(runtime.ocr_assets / 'tesseract.js' / 'dist' / 'worker.min.js', 'application/javascript')

    @router.get('/api/ocr/assets/core/{filename}')
    def ocr_core_asset(filename: str) -> FileResponse:
        allowed = {'tesseract-core.wasm.js', 'tesseract-core.wasm', 'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm', 'tesseract-core-simd.wasm.js', 'tesseract-core-simd.wasm', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd.wasm', 'tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm'}
        if filename not in allowed:
            raise HTTPException(404, 'OCR 核心资源不存在。')
        media_type = 'application/wasm' if filename.endswith('.wasm') else 'application/javascript'
        return ocr_asset(runtime.ocr_assets / 'tesseract.js-core' / filename, media_type)

    @router.get('/api/ocr/assets/lang/{filename}')
    def ocr_language_asset(filename: str) -> FileResponse:
        languages = {'chi_sim.traineddata.gz': 'chi_sim', 'eng.traineddata.gz': 'eng'}
        language = languages.get(filename)
        if not language:
            raise HTTPException(404, 'OCR 语言资源不存在。')
        path = runtime.ocr_assets / '@tesseract.js-data' / language / '4.0.0' / filename
        return ocr_asset(path, 'application/gzip')

    return router
