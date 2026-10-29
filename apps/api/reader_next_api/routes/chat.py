from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..citation_verification import verify_citations
from ..providers import provider_error_message
from ..rag import format_rag_context
from ..reading_agent import research_answer
from ..web_search import format_web_context, search_professional_web_results


from ..schemas import ChatInput
from ..runtime import Runtime


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.post('/api/chat/stream')
    async def chat_stream(payload: ChatInput) -> StreamingResponse:
        if payload.use_agent and (not payload.use_rag or not (payload.document_ids or payload.document_id)):
            raise HTTPException(422, '深度问答需要选择单书全文或多书联系。')
        try:
            profile = runtime.repository.profile(payload.profile_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        api_key = runtime.credential_store.get(profile.id)
        if not api_key:
            raise HTTPException(409, '该模型配置尚未保存 API Key。')
        if payload.document_id and payload.persist_history:
            try:
                runtime.repository.add_chat_message(payload.document_id, 'user', payload.question.strip())
            except LookupError as error:
                raise HTTPException(404, str(error)) from error

        async def events():
            answer = ''
            try:
                if payload.use_agent:
                    async for event in research_answer(payload, runtime.repository, runtime.provider, profile, api_key, search_professional_web_results):
                        yield f'data: {json.dumps(event, ensure_ascii=False)}\n\n'
                    return
                rag_sources = []
                if payload.use_rag:
                    document_ids = list(dict.fromkeys(payload.document_ids or ([payload.document_id] if payload.document_id else [])))
                    if not document_ids:
                        raise ValueError('全文 RAG 问答需要指定教材。')
                    rag_sources = runtime.repository.search_rag_many(document_ids, payload.question, min(20, max(10, len(document_ids) * 4)))
                    yield f'data: {json.dumps({'type': 'sources', 'sources': rag_sources, 'status': runtime.repository.rag_status_many(document_ids)}, ensure_ascii=False)}\n\n'
                web_sources = await search_professional_web_results(payload.question) if payload.use_web else []
                web_context = format_web_context(web_sources)
                if payload.use_web:
                    yield f'data: {json.dumps({'type': 'web_sources', 'sources': web_sources}, ensure_ascii=False)}\n\n'
                async for delta in runtime.provider.stream(profile, api_key, excerpt=payload.excerpt, question=payload.question, history=payload.history, page_number=payload.page_number, max_tokens=payload.max_tokens, use_web=payload.use_web, web_context=web_context, rag_context=format_rag_context(rag_sources) if payload.use_rag else ''):
                    answer += delta
                    yield f'data: {json.dumps({'type': 'delta', 'text': delta}, ensure_ascii=False)}\n\n'
                if payload.document_id and payload.persist_history and answer.strip():
                    runtime.repository.add_chat_message(payload.document_id, 'assistant', answer)
                if payload.use_rag and payload.verify_citations and answer.strip():
                    yield 'data: {"type":"verification_started"}\n\n'
                    verification = await verify_citations(answer, rag_sources, runtime.provider, profile, api_key)
                    yield f'data: {json.dumps({'type': 'citation_verification', 'verification': verification}, ensure_ascii=False)}\n\n'
                yield 'data: {"type":"complete"}\n\n'
            except Exception as error:
                message = '深度问答已超时，已停止后续调用；可缩小问题范围后重试。' if payload.use_agent and isinstance(error, TimeoutError) else provider_error_message(error)
                yield f'data: {json.dumps({'type': 'error', 'error': message}, ensure_ascii=False)}\n\n'
        return StreamingResponse(events(), media_type='text/event-stream')

    return router
