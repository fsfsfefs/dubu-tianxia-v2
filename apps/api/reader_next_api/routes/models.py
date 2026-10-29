from __future__ import annotations

import asyncio
import zipfile
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from ..domain import ModelProfile, normalize_chat_completions_endpoint
from ..providers import provider_error_message


from ..schemas import EmbeddingDownloadInput, EmbeddingSelectionInput, ProfileInput, ProfileTestInput
from ..runtime import Runtime


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.get('/api/embedding-models')
    def embedding_models() -> dict:
        return runtime.repository.list_embedding_models()

    @router.post('/api/embedding-models/download')
    async def download_embedding_model(payload: EmbeddingDownloadInput) -> dict:
        try:
            model = await asyncio.to_thread(runtime.repository.download_embedding_model, payload.model_name)
            return {'model': model}
        except (ValueError, RuntimeError) as error:
            raise HTTPException(400, str(error)) from error

    @router.post('/api/embedding-models/import')
    async def import_embedding_model(file: UploadFile=File(...), name: str=Form(...), model_name: str=Form(...)) -> dict:
        if not (file.filename or '').lower().endswith('.zip'):
            raise HTTPException(400, '只支持导入 ZIP 格式的 FastEmbed ONNX 模型。')
        payload = await file.read()
        try:
            model = await asyncio.to_thread(runtime.repository.import_embedding_model, name, model_name, payload)
            return {'model': model}
        except (ValueError, RuntimeError, zipfile.BadZipFile) as error:
            raise HTTPException(400, str(error)) from error

    @router.put('/api/embedding-models/active')
    async def select_embedding_model(payload: EmbeddingSelectionInput) -> dict:
        try:
            return await asyncio.to_thread(runtime.repository.select_embedding_model, payload.model_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except (ValueError, RuntimeError) as error:
            raise HTTPException(400, str(error)) from error

    @router.get('/api/model-profiles')
    def model_profiles() -> dict:
        return {'profiles': runtime.repository.list_profiles()}

    @router.post('/api/model-profiles', status_code=201)
    def save_model_profile(payload: ProfileInput) -> dict:
        profile = ModelProfile(id=payload.id or str(uuid4()), name=payload.name, endpoint=normalize_chat_completions_endpoint(payload.endpoint), model=payload.model, temperature=payload.temperature, max_tokens=payload.max_tokens, is_default=payload.is_default)
        try:
            profile.validate()
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        credential_backend = None
        if payload.api_key:
            try:
                credential_backend = runtime.credential_store.set(profile.id, payload.api_key)
            except (ValueError, RuntimeError) as error:
                raise HTTPException(503, str(error)) from error
        saved = runtime.repository.save_profile(profile)
        return {'profile': saved, 'credential_saved': bool(payload.api_key), 'credential_backend': credential_backend}

    @router.delete('/api/model-profiles/{profile_id}', status_code=204)
    def delete_model_profile(profile_id: str) -> None:
        if not runtime.repository.delete_profile(profile_id):
            raise HTTPException(404, '模型配置不存在。')
        runtime.credential_store.delete(profile_id)

    @router.post('/api/model-profiles/test')
    async def test_model_draft(payload: ProfileTestInput) -> dict:
        try:
            profile = ModelProfile(id=payload.id or 'temporary-test', name='临时连接测试', endpoint=normalize_chat_completions_endpoint(payload.endpoint), model=payload.model.strip(), temperature=payload.temperature, max_tokens=payload.max_tokens)
            profile.validate()
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        api_key = (payload.api_key or '').strip()
        if not api_key and payload.id:
            try:
                runtime.repository.profile(payload.id)
            except LookupError as error:
                raise HTTPException(404, str(error)) from error
            api_key = runtime.credential_store.get(payload.id)
        if not api_key:
            raise HTTPException(409, '请填写 API Key 后测试；已有配置留空时使用已保存的密钥。')
        try:
            answer = await runtime.provider.complete(profile, api_key, system='只执行连通性测试。', prompt='请只回复 OK')
        except Exception as error:
            raise HTTPException(502, provider_error_message(error)) from error
        return {'ok': True, 'response': answer[:100]}

    @router.post('/api/model-profiles/{profile_id}/test')
    async def test_model_profile(profile_id: str) -> dict:
        try:
            profile = runtime.repository.profile(profile_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        api_key = runtime.credential_store.get(profile.id)
        if not api_key:
            raise HTTPException(409, '该模型配置尚未保存 API Key。')
        try:
            answer = await runtime.provider.complete(profile, api_key, system='只执行连通性测试。', prompt='请只回复 OK')
        except Exception as error:
            raise HTTPException(502, provider_error_message(error)) from error
        return {'ok': True, 'response': answer[:100]}

    return router
