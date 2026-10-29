from reader_next_api.repository import Repository


def test_pdf_import_is_content_addressed_and_keeps_one_file(tmp_path):
    repository = Repository(tmp_path)
    content = b"%PDF-1.7\nfixture"

    first = repository.add_document("chapter.pdf", content)
    second = repository.add_document("duplicate.pdf", content)

    assert first["id"] == second["id"]
    assert first["title"] == "chapter"
    assert repository.document_path(first["id"]).read_bytes() == content
    assert len(repository.list_documents()) == 1


def test_non_pdf_upload_is_rejected(tmp_path):
    repository = Repository(tmp_path)

    try:
        repository.add_document("notes.txt", b"not a pdf")
    except ValueError as error:
        assert "PDF" in str(error)
    else:
        raise AssertionError("invalid file was accepted")


def test_reading_position_is_saved_per_document(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")

    assert repository.get_position(document["id"])["page_number"] == 1
    saved = repository.save_position(document["id"], 12, 1.4, 0.62)

    assert saved["page_number"] == 12
    assert saved["page_offset"] == 0.62
    assert saved["zoom"] == 1.4


def test_page_text_index_is_persisted_and_upserted(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")

    repository.save_ocr_page(document["id"], 3, "first indexed text")
    repository.save_ocr_page(document["id"], 3, "updated indexed text")
    repository.save_ocr_page(document["id"], 8, "another page")

    pages = repository.list_ocr_pages(document["id"])
    assert [(page["page_number"], page["text"]) for page in pages] == [
        (3, "updated indexed text"),
        (8, "another page"),
    ]


def test_chapter_summary_is_persisted_and_upserted(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")

    repository.save_chapter_summary(document["id"], "chapter-1", "第一章", 3, 18, 1, "初版结构")
    updated = repository.save_chapter_summary(
        document["id"], "chapter-1", "第一章", 3, 20, 1, "更新后的知识结构"
    )

    summaries = repository.list_chapter_summaries(document["id"])
    assert updated["end_page"] == 20
    assert [(item["chapter_key"], item["content"]) for item in summaries] == [
        ("chapter-1", "更新后的知识结构")
    ]


def test_highlight_round_trip(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    rects = [{"x": 0.1, "y": 0.2, "width": 0.3, "height": 0.04}]

    created = repository.add_highlight(document["id"], 3, "关键原文", rects, "yellow")
    highlights = repository.list_highlights(document["id"])

    assert created["text"] == "关键原文"
    assert highlights[0]["rects"] == rects


def test_page_marker_is_stored_as_highlight_without_rectangles(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")

    created = repository.add_highlight(document["id"], 9, "整页星标 · PDF 第 9 页", [], "yellow")

    assert created["page_number"] == 9
    assert created["rects"] == []
    assert repository.list_highlights(document["id"])[0]["text"] == "整页星标 · PDF 第 9 页"


def test_notes_can_be_created_and_deleted(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    note = repository.add_note(document["id"], 4, "原文", "我的理解")

    assert repository.list_notes(document["id"])[0]["content"] == "我的理解"
    assert repository.delete_note(document["id"], note["id"])
    assert repository.list_notes(document["id"]) == []


def test_chat_history_is_scoped_to_document(tmp_path):
    repository = Repository(tmp_path)
    first = repository.add_document("first.pdf", b"%PDF-1.7\nfirst")
    second = repository.add_document("second.pdf", b"%PDF-1.7\nsecond")

    repository.add_chat_message(first["id"], "user", "问题")
    repository.add_chat_message(first["id"], "assistant", "回答")

    assert [item["role"] for item in repository.list_chat_messages(first["id"])] == ["user", "assistant"]
    assert repository.list_chat_messages(second["id"]) == []


def test_note_can_be_updated(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    note = repository.add_note(document["id"], 2, "原文", "旧内容")

    updated = repository.update_note(document["id"], note["id"], "新内容")

    assert updated["content"] == "新内容"


def test_flashcards_round_trip(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    cards = repository.add_flashcards(
        document["id"], 6, "教材摘录", [{"question": "什么是对象？", "answer": "数据与行为的封装。"}]
    )

    assert repository.list_flashcards(document["id"])[0]["page_number"] == 6
    assert repository.delete_flashcard(document["id"], cards[0]["id"])


def test_document_can_be_renamed_and_deleted_with_related_data(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    repository.add_note(document["id"], 1, "", "note")

    renamed = repository.rename_document(document["id"], "新标题")
    path = repository.document_path(document["id"])
    repository.delete_document(document["id"])

    assert renamed["title"] == "新标题"
    assert not path.exists()
    assert repository.list_documents() == []


def test_highlight_can_change_color_and_be_deleted(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    highlight = repository.add_highlight(
        document["id"], 2, "text", [{"x": 0.1, "y": 0.1, "width": 0.2, "height": 0.1}], "yellow"
    )

    updated = repository.update_highlight_color(document["id"], highlight["id"], "pink")

    assert updated["color"] == "pink"
    assert repository.delete_highlight(document["id"], highlight["id"])


def test_flashcard_edit_and_review_progress(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("chapter.pdf", b"%PDF-1.7\nfixture")
    card = repository.add_flashcard(document["id"], 3, "source", "Q", "A")

    edited = repository.update_flashcard(document["id"], card["id"], "Q2", "A2")
    reviewed = repository.review_flashcard(document["id"], card["id"], True)

    assert edited["question"] == "Q2"
    assert reviewed["review_count"] == 1
    assert reviewed["mastered"] == 1


def test_folders_organize_documents_without_deleting_them(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("os.pdf", b"%PDF-1.7\nfolder")
    folder = repository.create_folder("操作系统")

    moved = repository.move_document(document["id"], folder["id"])
    assert moved["folder_id"] == folder["id"]
    assert repository.list_folders()[0]["document_count"] == 1

    renamed = repository.rename_folder(folder["id"], "系统课程")
    assert renamed["name"] == "系统课程"

    repository.delete_folder(folder["id"])
    assert repository.list_documents()[0]["folder_id"] is None
    assert repository.document_path(document["id"]).exists()


def test_duplicate_folder_names_are_rejected_case_insensitively(tmp_path):
    repository = Repository(tmp_path)
    repository.create_folder("Computer Science")

    try:
        repository.create_folder("computer science")
    except ValueError as error:
        assert "同名" in str(error)
    else:
        raise AssertionError("duplicate folder was accepted")


def test_imported_learning_structure_persists_outline_and_summaries(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document("os.pdf", b"%PDF-1.7\nstructure")
    outline = [
        {"title": "Chapter 1", "page": 11, "depth": 0},
        {"title": "1.1 Processes", "page": 13, "depth": 1},
    ]
    summaries = [
        {
            "chapter_key": f"{document['id']}:0", "title": "Chapter 1",
            "start_page": 11, "end_page": 30, "depth": 0,
            "content": "Imported chapter summary",
        },
        {
            "chapter_key": f"{document['id']}:__book__", "title": "Book structure",
            "start_page": 1, "end_page": 30, "depth": 0,
            "content": "Imported book structure",
        },
    ]

    imported = repository.import_learning_structure(document["id"], outline, summaries)
    assert repository.export_data()["document_outlines"][0]["title"] == "Chapter 1"
    reopened = Repository(tmp_path)

    assert [item["title"] for item in imported["outline"]] == ["Chapter 1", "1.1 Processes"]
    assert reopened.get_imported_outline(document["id"])[1]["page"] == 13
    saved = reopened.list_chapter_summaries(document["id"])
    assert {item["content"] for item in saved} == {
        "Imported chapter summary", "Imported book structure",
    }


def test_summary_checkpoints_persist_and_follow_document_lifecycle(tmp_path):
    repository = Repository(tmp_path)
    document = repository.add_document('chapter.pdf', b'%PDF-1.7\ncheckpoint')
    key = 'a' * 64
    assert repository.summary_checkpoint(document['id'], key) is None
    repository.save_summary_checkpoint(document['id'], key, '分块总结')
    assert Repository(tmp_path).summary_checkpoint(document['id'], key) == '分块总结'
    assert repository.list_chapter_summaries(document['id']) == []
    repository.delete_document(document['id'])
    with repository.connect() as connection:
        assert connection.execute('SELECT count(*) FROM summary_checkpoints').fetchone()[0] == 0
