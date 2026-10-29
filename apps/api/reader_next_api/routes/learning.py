from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from ..providers import provider_error_message


from ..schemas import ChapterSummaryInput, FlashcardGenerateInput, FlashcardInput, FlashcardReviewInput, FlashcardUpdateInput, HighlightInput, HighlightUpdateInput, LearningStructureImportInput, NoteInput, NoteUpdateInput, SummaryCheckpointInput
from ..runtime import Runtime


def parse_generated_flashcards(raw: str, count: int | None=None) -> list[dict]:
    start, end = (raw.find('['), raw.rfind(']'))
    parsed = json.loads(raw[start:end + 1]) if start >= 0 and end > start else None
    if not isinstance(parsed, list):
        raise ValueError('模型未返回卡片数组。')
    items = parsed if count is None else parsed[:count]
    cards = []
    for item in items:
        if not isinstance(item, dict):
            continue
        question = str(item.get('question', '')).strip()[:1000]
        answer = str(item.get('answer', '')).strip()[:4000]
        if question and answer:
            cards.append({'question': question, 'answer': answer})
    if not cards:
        raise ValueError('没有识别到可生成卡片的问题。请重新框选包含题目的区域。')
    return cards


def create_router(runtime: Runtime) -> APIRouter:
    router = APIRouter()

    @router.get('/api/documents/{document_id}/chapter-summaries')
    def document_chapter_summaries(document_id: str) -> dict:
        try:
            return {'summaries': runtime.repository.list_chapter_summaries(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/imported-outline')
    def document_imported_outline(document_id: str) -> dict:
        try:
            return {'outline': runtime.repository.get_imported_outline(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.put('/api/documents/{document_id}/learning-structure-import')
    def import_document_learning_structure(document_id: str, payload: LearningStructureImportInput) -> dict:
        if any(task["document_id"] == document_id and task["task_type"] == "structure-summary" and task["status"] in {"queued", "running", "cancelling"} for task in runtime.task_manager.list()):
            raise HTTPException(409, "请先暂停或结束本教材的总结任务，再导入新目录。")
        for summary in payload.summaries:
            if summary.end_page < summary.start_page:
                raise HTTPException(400, f'章节“{summary.title}”的结束页不能早于开始页。')
        try:
            return runtime.repository.import_learning_structure(document_id, [item.model_dump() for item in payload.outline], [item.model_dump() for item in payload.summaries])
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/summary-gaps')
    def summary_gaps(document_id: str) -> dict:
        try:
            return {'gaps': runtime.repository.list_summary_gaps(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/summary-checkpoints/{key}')
    def get_summary_checkpoint(document_id: str, key: str) -> dict:
        if len(key) != 64 or any((char not in '0123456789abcdef' for char in key)):
            raise HTTPException(422, '无效的分块标识')
        try:
            return {'content': runtime.repository.summary_checkpoint(document_id, key)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.put('/api/documents/{document_id}/summary-checkpoints/{key}')
    def put_summary_checkpoint(document_id: str, key: str, payload: SummaryCheckpointInput) -> dict:
        if len(key) != 64 or any((char not in '0123456789abcdef' for char in key)):
            raise HTTPException(422, '无效的分块标识')
        try:
            runtime.repository.save_summary_checkpoint(document_id, key, payload.content)
            return {'content': payload.content}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.put('/api/documents/{document_id}/chapter-summaries/{chapter_key}')
    def save_document_chapter_summary(document_id: str, chapter_key: str, payload: ChapterSummaryInput) -> dict:
        if payload.chapter_key != chapter_key:
            raise HTTPException(400, '章节标识不一致。')
        if payload.end_page < payload.start_page:
            raise HTTPException(400, '章节结束页不能早于开始页。')
        try:
            return {'summary': runtime.repository.save_chapter_summary(document_id, chapter_key, payload.title.strip(), payload.start_page, payload.end_page, payload.depth, payload.content.strip())}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/highlights')
    def document_highlights(document_id: str) -> dict:
        try:
            highlights = runtime.repository.list_highlights(document_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'highlights': highlights}

    @router.post('/api/documents/{document_id}/highlights', status_code=201)
    def create_highlight(document_id: str, payload: HighlightInput) -> dict:
        try:
            highlight = runtime.repository.add_highlight(document_id, payload.page_number, payload.text.strip(), [rect.model_dump() for rect in payload.rects], payload.color, payload.comment.strip(), [tag.strip() for tag in payload.tags if tag.strip()][:30])
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'highlight': highlight}

    @router.put('/api/documents/{document_id}/highlights/{highlight_id}')
    def update_highlight(document_id: str, highlight_id: str, payload: HighlightUpdateInput) -> dict:
        try:
            return {'highlight': runtime.repository.update_highlight(document_id, highlight_id, payload.color, payload.comment.strip(), [tag.strip() for tag in payload.tags if tag.strip()][:30])}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.delete('/api/documents/{document_id}/highlights/{highlight_id}', status_code=204)
    def delete_highlight(document_id: str, highlight_id: str) -> None:
        try:
            deleted = runtime.repository.delete_highlight(document_id, highlight_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        if not deleted:
            raise HTTPException(404, '高亮不存在。')

    @router.get('/api/documents/{document_id}/notes')
    def document_notes(document_id: str) -> dict:
        try:
            return {'notes': runtime.repository.list_notes(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.post('/api/documents/{document_id}/notes', status_code=201)
    def create_note(document_id: str, payload: NoteInput) -> dict:
        try:
            note = runtime.repository.add_note(document_id, payload.page_number, payload.excerpt.strip(), payload.content.strip(), payload.title.strip(), [tag.strip() for tag in payload.tags if tag.strip()][:30], payload.pinned)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'note': note}

    @router.put('/api/documents/{document_id}/notes/{note_id}')
    def update_note(document_id: str, note_id: str, payload: NoteUpdateInput) -> dict:
        try:
            note = runtime.repository.update_note(document_id, note_id, payload.content.strip(), payload.title.strip(), [tag.strip() for tag in payload.tags if tag.strip()][:30], payload.pinned)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'note': note}

    @router.delete('/api/documents/{document_id}/notes/{note_id}', status_code=204)
    def delete_note(document_id: str, note_id: str) -> None:
        try:
            deleted = runtime.repository.delete_note(document_id, note_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        if not deleted:
            raise HTTPException(404, '笔记不存在。')

    @router.get('/api/documents/{document_id}/chat')
    def chat_history(document_id: str) -> dict:
        try:
            return {'messages': runtime.repository.list_chat_messages(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.delete('/api/documents/{document_id}/chat', status_code=204)
    def clear_chat_history(document_id: str) -> None:
        try:
            runtime.repository.clear_chat_messages(document_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.get('/api/documents/{document_id}/flashcards')
    def document_flashcards(document_id: str) -> dict:
        try:
            return {'flashcards': runtime.repository.list_flashcards(document_id)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.post('/api/documents/{document_id}/flashcards/generate', status_code=201)
    async def generate_flashcards(document_id: str, payload: FlashcardGenerateInput) -> dict:
        try:
            runtime.repository.document_path(document_id)
            profile = runtime.repository.profile(payload.profile_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        api_key = runtime.credential_store.get(profile.id)
        if not api_key:
            raise HTTPException(409, '该模型配置尚未保存 API Key。')
        request = f'根据以下教材原文生成 {payload.count} 张互不重复的中文问答卡片' if payload.count is not None else '识别以下教材原文中出现的全部问题，不限制问题数量，不要合并或遗漏，并为每个问题给出准确答案'
        try:
            raw = await runtime.provider.complete(profile, api_key, system='你是教材题目识别与作答助手。只输出 JSON 数组，不要 Markdown。每项必须包含 question 和 answer 字符串，并保持题目原意。', prompt=f'{request}：\n\n{payload.excerpt}')
            cards = parse_generated_flashcards(raw, payload.count)
            saved = runtime.repository.add_flashcards(document_id, payload.page_number, payload.excerpt, cards)
        except (ValueError, json.JSONDecodeError) as error:
            raise HTTPException(502, str(error)) from error
        except Exception as error:
            raise HTTPException(502, provider_error_message(error)) from error
        return {'flashcards': saved}

    @router.post('/api/documents/{document_id}/flashcards', status_code=201)
    def create_flashcard(document_id: str, payload: FlashcardInput) -> dict:
        try:
            card = runtime.repository.add_flashcard(document_id, payload.page_number, payload.source_excerpt, payload.question.strip(), payload.answer.strip())
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        return {'flashcard': card}

    @router.put('/api/documents/{document_id}/flashcards/{card_id}')
    def update_flashcard(document_id: str, card_id: str, payload: FlashcardUpdateInput) -> dict:
        try:
            return {'flashcard': runtime.repository.update_flashcard(document_id, card_id, payload.question.strip(), payload.answer.strip())}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.post('/api/documents/{document_id}/flashcards/{card_id}/review')
    def review_flashcard(document_id: str, card_id: str, payload: FlashcardReviewInput) -> dict:
        try:
            return {'flashcard': runtime.repository.review_flashcard(document_id, card_id, payload.mastered)}
        except LookupError as error:
            raise HTTPException(404, str(error)) from error

    @router.delete('/api/documents/{document_id}/flashcards/{card_id}', status_code=204)
    def delete_flashcard(document_id: str, card_id: str) -> None:
        try:
            deleted = runtime.repository.delete_flashcard(document_id, card_id)
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
        if not deleted:
            raise HTTPException(404, '知识卡片不存在。')

    @router.post('/api/documents/{document_id}/outline/reconcile')
    def reconcile_outline(document_id: str, payload: LearningStructureImportInput) -> dict:
        outline = [node.model_dump() for node in payload.outline]
        runtime.repository.reconcile_chapter_keys(document_id, outline)
        return {"summaries": runtime.repository.list_chapter_summaries(document_id), "gaps": runtime.repository.list_summary_gaps(document_id)}

    return router
