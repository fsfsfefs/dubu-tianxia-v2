from reader_next_api.full_backup import create_full_backup, inspect_backup, install_full_backup
from reader_next_api.repository import Repository


def test_full_backup_round_trip(tmp_path):
    source_root = tmp_path / "source"
    repository = Repository(source_root)
    document = repository.add_document("book.pdf", b"%PDF-1.7\nbackup fixture")
    repository.add_note(document["id"], 2, "原文", "理解", "标题", ["复习"], True)
    repository.add_highlight(document["id"], 2, "关键原文", [], "green", "备注", ["重点"])
    repository.save_ocr_page(document["id"], 2, "可搜索文字")

    archive = tmp_path / "backup.zip"
    result = create_full_backup(source_root, archive)
    assert result["file_count"] >= 2
    assert archive.is_file()

    staging = tmp_path / "staging"
    manifest = inspect_backup(archive, staging)
    assert manifest["format"] == "reader-next-full-backup"
    assert manifest["credentials_included"] is False

    target_root = tmp_path / "target"
    Repository(target_root)
    counts = install_full_backup(target_root, staging)
    restored = Repository(target_root)

    assert counts["documents"] == 1
    assert restored.document_path(document["id"]).read_bytes() == b"%PDF-1.7\nbackup fixture"
    assert restored.list_notes(document["id"])[0]["tags"] == ["复习"]
    assert restored.list_notes(document["id"])[0]["pinned"] is True
    assert restored.list_highlights(document["id"])[0]["comment"] == "备注"
    assert restored.list_ocr_pages(document["id"])[0]["text"] == "可搜索文字"

