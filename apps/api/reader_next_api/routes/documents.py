from __future__ import annotations


from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse


from ..schemas import DocumentUpdateInput, FolderInput, FolderMoveInput, OcrPageInput, PositionInput
from ..runtime import Runtime


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.get('/api/documents')
    def documents() -> dict:
        return {'documents': runtime.repository.list_documents()}

    @router.get('/api/folders')
    def folders() -> dict:
        return {'folders': runtime.repository.list_folders()}

    @router.post('/api/folders', status_code=201)
    def create_folder(payload: FolderInput) -> dict:
        try:
            return {'folder': runtime.repository.create_folder(payload.name)}
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.put('/api/folders/{folder_id}')
    def rename_folder(folder_id: str, payload: FolderInput) -> dict:
        try:
            return {'folder': runtime.repository.rename_folder(folder_id, payload.name)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.delete('/api/folders/{folder_id}', status_code=204)
    def delete_folder(folder_id: str) -> None:
        try:
            runtime.repository.delete_folder(folder_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.post('/api/documents', status_code=201)
    async def upload_document(file: UploadFile=File(...)) -> dict:
        content = await file.read(100 * 1024 * 1024 + 1)
        if len(content) > 100 * 1024 * 1024:
            raise HTTPException(413, 'PDF 不能超过 100 MB。')
        try:
            document = runtime.repository.add_document(file.filename or 'document.pdf', content)
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        task = runtime.task_manager.enqueue_index(document['id'])
        return {'document': document, 'task': task}

    @router.put('/api/documents/{document_id}')
    def rename_document(document_id: str, payload: DocumentUpdateInput) -> dict:
        try:
            return {'document': runtime.repository.rename_document(document_id, payload.title)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        except ValueError as error:
            raise HTTPException(400, str(error)) from error

    @router.put('/api/documents/{document_id}/folder')
    def move_document_to_folder(document_id: str, payload: FolderMoveInput) -> dict:
        try:
            return {'document': runtime.repository.move_document(document_id, payload.folder_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.delete('/api/documents/{document_id}', status_code=204)
    def delete_document(document_id: str) -> None:
        try:
            runtime.repository.delete_document(document_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/file')
    def document_file(document_id: str) -> FileResponse:
        try:
            path = runtime.repository.document_path(document_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return FileResponse(path, media_type='application/pdf', filename=path.name)

    @router.get('/api/documents/{document_id}/position')
    def reading_position(document_id: str) -> dict:
        try:
            return {'position': runtime.repository.get_position(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.put('/api/documents/{document_id}/position')
    def save_reading_position(document_id: str, payload: PositionInput) -> dict:
        try:
            position = runtime.repository.save_position(document_id, payload.page_number, payload.zoom, payload.page_offset)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'position': position}

    @router.get('/api/documents/{document_id}/ocr-pages')
    def document_ocr_pages(document_id: str) -> dict:
        try:
            return {'pages': runtime.repository.list_ocr_pages(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.put('/api/documents/{document_id}/ocr-pages/{page_number}')
    def save_document_ocr_page(document_id: str, page_number: int, payload: OcrPageInput) -> dict:
        if page_number < 1:
            raise HTTPException(400, '页码必须大于 0。')
        try:
            return {'page': runtime.repository.save_ocr_page(document_id, page_number, payload.text)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/rag/status')
    def document_rag_status(document_id: str) -> dict:
        try:
            return {'status': runtime.repository.rag_status(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/rag/search')
    def document_rag_search(document_id: str, q: str, limit: int=8) -> dict:
        if not q.strip():
            raise HTTPException(400, '检索问题不能为空。')
        try:
            return {'sources': runtime.repository.search_rag(document_id, q.strip(), max(1, min(limit, 20)))}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    return router
