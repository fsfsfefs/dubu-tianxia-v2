from __future__ import annotations


from fastapi import APIRouter, HTTPException


from ..schemas import IndexTaskInput, OutlineEntryInput, SummaryTaskInput
from ..runtime import Runtime


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.get('/api/tasks')
    def background_tasks() -> dict:
        return {'tasks': runtime.task_manager.list()}

    @router.post('/api/tasks/index', status_code=202)
    def create_index_tasks(payload: IndexTaskInput) -> dict:
        tasks = []
        try:
            for document_id in dict.fromkeys(payload.document_ids):
                tasks.append(runtime.task_manager.enqueue_index(document_id))
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'tasks': tasks}

    @router.post('/api/tasks/summary', status_code=202)
    def create_summary_task(payload: SummaryTaskInput) -> dict:
        try:
            outline = [OutlineEntryInput(**item).model_dump() for item in payload.outline]
            pages = [item['page'] for item in outline]
            if pages != sorted(pages) or (payload.chapter_index is not None and payload.chapter_index >= len(outline)):
                raise ValueError('章节顺序或目标章节无效。')
            runtime.repository.profile(payload.profile_id)
            if not runtime.credential_store.get(payload.profile_id):
                raise ValueError('请先保存此模型的 API Key。')
            return {'task': runtime.task_manager.enqueue_summary(payload.document_id, {'profile_id': payload.profile_id, 'outline': outline, 'chapter_index': payload.chapter_index})}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.post('/api/tasks/{task_id}/pause')
    def pause_summary_task(task_id: str) -> dict:
        try:
            return {'task': runtime.task_manager.pause(task_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.post('/api/tasks/{task_id}/cancel')
    def cancel_background_task(task_id: str) -> dict:
        try:
            return {'task': runtime.task_manager.cancel(task_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.post('/api/tasks/{task_id}/retry', status_code=202)
    def retry_background_task(task_id: str) -> dict:
        try:
            return {'task': runtime.task_manager.retry(task_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.delete('/api/tasks/finished')
    def clear_finished_background_tasks() -> dict:
        return {'deleted': runtime.task_manager.clear_finished()}

    return router
