import pytest
import json
from fastapi.testclient import TestClient
from types import SimpleNamespace

from reader_next_api.application import create_app
from reader_next_api.schemas import HighlightInput
from reader_next_api.routes.learning import create_router
from reader_next_api.repository import Repository


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        client.app.state.runtime.task_manager.enqueue_index = lambda _: {"status": "queued"}
        yield client


def test_document_lifecycle_and_export(client):

    created = client.post(
        "/api/documents", files={"file": ("chapter.pdf", b"%PDF-1.7\nfixture", "application/pdf")}
    )
    assert created.status_code == 201
    document_id = created.json()["document"]["id"]

    renamed = client.put(f"/api/documents/{document_id}", json={"title": "新标题"})
    assert renamed.json()["document"]["title"] == "新标题"
    assert client.get("/api/export").json()["data"]["documents"][0]["title"] == "新标题"

    deleted = client.delete(f"/api/documents/{document_id}")
    assert deleted.status_code == 204


def test_manual_flashcard_and_review_api(client):
    repository = client.app.state.runtime.repository
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")

    created = client.post(
        f"/api/documents/{document['id']}/flashcards",
        json={"page_number": 1, "source_excerpt": "source", "question": "Q", "answer": "A"},
    )
    card_id = created.json()["flashcard"]["id"]
    reviewed = client.post(
        f"/api/documents/{document['id']}/flashcards/{card_id}/review", json={"mastered": True}
    )

    assert created.status_code == 201
    assert reviewed.json()["flashcard"]["mastered"] == 1


def test_flashcard_parser_keeps_all_recognized_questions():
    raw = json.dumps([
        {"question": f"问题 {index}", "answer": f"答案 {index}"}
        for index in range(1, 13)
    ], ensure_ascii=False)

    import json as _json
    from reader_next_api.routes.learning import parse_generated_flashcards
    cards = parse_generated_flashcards(raw)

    assert len(cards) == 12
    assert cards[-1]["question"] == "问题 12"
    assert len(parse_generated_flashcards(raw, 3)) == 3


def test_highlight_input_accepts_smooth_ink_colors_and_points():
    points = [{"x": index / 1200, "y": index / 1200, "width": 0.004, "height": 0.004} for index in range(1200)]

    assert HighlightInput(page_number=1, text="黑色笔迹", rects=points, color="black").color == "black"
    assert HighlightInput(page_number=1, text="红色笔迹", rects=points, color="red").color == "red"
