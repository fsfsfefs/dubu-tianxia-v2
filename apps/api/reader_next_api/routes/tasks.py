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
            target = payload.chapter_index
            leaf = payload.imported_leaf_index
            if leaf is not None:
                if leaf >= len(outline) or (leaf + 1 < len(outline) and outline[leaf + 1]["depth"] > outline[leaf]["depth"]):
                    raise ValueError('只能从小章更新上级总结。')
                depth = outline[leaf]["depth"]
                for index in range(leaf - 1, -1, -1):
                    if outline[index]["depth"] < depth:
                        target, depth = index, outline[index]["depth"]
            return {'task': runtime.task_manager.enqueue_summary(payload.document_id, {
                'profile_id': payload.profile_id, 'outline': outline, 'chapter_index': target,
                'imported_leaf_index': leaf,
            })}
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

    @router.delete('/api/tasks/{task_id}')
    def delete_background_task(task_id: str) -> dict:
        runtime.task_manager.delete(task_id)
        return {'deleted': True}

    return router
