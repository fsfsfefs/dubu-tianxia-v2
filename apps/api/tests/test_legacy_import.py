import hashlib
import json
import sqlite3
from io import BytesIO
from pathlib import Path

import pytest
from pypdf import PdfWriter
from fastapi.testclient import TestClient

from reader_next_api.application import create_app
from reader_next_api.repository import Repository
from reader_next_api.chapters import chapter_key
from reader_next_api.full_backup import create_full_backup, inspect_backup, install_full_backup
from reader_next_api.book_backup import create_book_backup, inspect_book_backup, install_book_backup
from reader_next_api.compatibility import normalize_legacy_chapters


def old_source(root):
    repo=Repository(root)
    writer=PdfWriter()
    for _ in range(2): writer.add_blank_page(width=200,height=300)
    writer.add_outline_item("第一章",0);writer.add_outline_item("第二章",1)
    stream=BytesIO();writer.write(stream)
    doc=repo.add_document("旧教材.pdf",stream.getvalue())["id"]
    repo.save_chapter_summary(doc,doc+":0","第一章",1,1,0,"旧章节总结，参见 PDF2。")
    repo.save_chapter_summary(doc,doc+":1","旧目录的另一章",2,2,0,"不应错误归属的历史总结 PDF1。")
    repo.add_note(doc,1,"原文","保留旧笔记")
    repo.save_ocr_page(doc,1,"虚拟内存与缺页中断")
    return repo,doc


def test_v1_full_backup_is_upgraded_in_staging_and_uses_new_chapter_keys(tmp_path):
    repo,doc=old_source(tmp_path/"source")
    with repo.connect() as c:
        c.execute("DROP TABLE schema_migrations")
        c.execute("DROP TABLE summary_gaps")
        c.execute("DROP TABLE summary_checkpoints")
        c.execute("DROP TABLE rag_chunks_fts")
        for column in ("title","tags_json","pinned","updated_at"):
            c.execute("ALTER TABLE notes DROP COLUMN "+column)
        c.execute("ALTER TABLE reading_positions DROP COLUMN page_offset")
    archive=tmp_path/"old.zip";create_full_backup(repo.root,archive)
    original=hashlib.sha256(archive.read_bytes()).hexdigest()
    staging=tmp_path/"stage"
    report=inspect_backup(archive,staging)["compatibility"]
    assert report=={"chapters_upgraded":1,"historical_records":1,"outlines_recovered":1}
    assert hashlib.sha256(archive.read_bytes()).hexdigest()==original
    root=tmp_path/"target";Repository(root)
    install_full_backup(root,staging)
    restored=Repository(root)
    outline=restored.get_imported_outline(doc)
    summaries={r["chapter_key"]:r for r in restored.list_chapter_summaries(doc)}
    assert summaries[chapter_key(doc,outline,0)]["content"]=="旧章节总结，参见 PDF2。"
    assert summaries[doc+":1"]["title"]=="旧目录的另一章"
    assert chapter_key(doc,outline,1) not in summaries
    assert restored.list_notes(doc)[0]["content"]=="保留旧笔记"
    assert restored.list_notes(doc)[0]["tags"]==[]
    assert restored.search_rag(doc,"虚拟内存")
    assert Repository(root).compatibility_report["chapters_upgraded"]==0


def test_unsupported_future_backup_does_not_replace_live_data(tmp_path):
    source,_=old_source(tmp_path/"source")
    with source.connect() as c:
        c.execute("INSERT INTO schema_migrations(version,name) VALUES (99,'future')")
    archive=tmp_path/"future.zip";create_full_backup(source.root,archive)
    with TestClient(create_app(tmp_path/"live")) as client:
        repo=client.app.state.runtime.repository
        original=repo.add_document("保留.pdf",b"%PDF-1.7\nkeep")
        response=client.post("/api/backup/restore",files={"file":("future.zip",archive.read_bytes(),"application/zip")})
        assert response.status_code==400
        assert [d["id"] for d in repo.list_documents()]==[original["id"]]
        assert repo.document_path(original["id"]).read_bytes()==b"%PDF-1.7\nkeep"
        assert not list(repo.root.glob(".restore-*"))


def test_conflicting_new_summary_is_not_overwritten_and_unrelated_book_is_not_migrated(tmp_path):
    repo,doc=old_source(tmp_path/"source")
    second=repo.add_document("其他.pdf",b"%PDF-1.7\nother")["id"]
    outline=[{"title":"第一章","page":1,"depth":0},{"title":"第二章","page":2,"depth":0}]
    repo.import_learning_structure(doc,outline,[])
    # Restore an intentionally conflicting historical record after outline import.
    repo.save_chapter_summary(doc,doc+":0","第一章",1,1,0,"历史版本")
    key=chapter_key(doc,outline,0)
    repo.save_chapter_summary(doc,key,"第一章",1,1,0,"新版版本")
    repo.save_chapter_summary(second,second+":0","其他",1,1,0,"其他书历史")
    with repo.connect() as c:
        report=normalize_legacy_chapters(c,repo.documents_dir,{doc})
    records={r["chapter_key"]:r["content"] for r in repo.list_chapter_summaries(doc)}
    assert records[key]=="新版版本" and records[doc+":0"]=="历史版本"
    assert repo.list_chapter_summaries(second)[0]["chapter_key"]==second+":0"


def test_older_single_book_missing_new_tables_backfills_index_and_converts_summary(tmp_path):
    source,doc=old_source(tmp_path/"source")
    archive=tmp_path/"book.zip";create_book_backup(source,doc,archive)
    # Build a checksum-valid older format-1 package with omitted optional tables/columns.
    import zipfile
    with zipfile.ZipFile(archive) as z: parts={name:z.read(name) for name in z.namelist()}
    data=json.loads(parts["book.json"])
    for table in ("summary_gaps","summary_checkpoints","background_tasks","rag_chunks"):
        data["tables"].pop(table)
    for note in data["tables"]["notes"]:
        for field in ("title","tags_json","pinned","updated_at"): note.pop(field)
    parts["book.json"]=json.dumps(data,ensure_ascii=False).encode()
    manifest=json.loads(parts["manifest.json"])
    manifest["files"]["book.json"]={"size":len(parts["book.json"]),"sha256":hashlib.sha256(parts["book.json"]).hexdigest()}
    parts["manifest.json"]=json.dumps(manifest).encode()
    old=tmp_path/"old-book.zip"
    with zipfile.ZipFile(old,"w") as z:
        for name,content in parts.items():z.writestr(name,content)
    stage=tmp_path/"stage";converted=inspect_book_backup(old,stage)
    target=Repository(tmp_path/"target")
    result=install_book_backup(target,converted,stage/"document.pdf")
    imported=result["document_id"]
    outline=target.get_imported_outline(imported)
    assert any(r["chapter_key"]==chapter_key(imported,outline,0) for r in target.list_chapter_summaries(imported))
    assert target.search_rag(imported,"虚拟内存")
    assert target.list_notes(imported)[0]["tags"]==[]

def test_imported_model_path_moves_with_the_data_directory(tmp_path):
    from reader_next_api.embedding_models import EmbeddingModelManager
    manager=EmbeddingModelManager(tmp_path)
    local=manager.models_dir/"imports"/"model-id"/"nested"
    local.mkdir(parents=True)
    manager.config_path.write_text(json.dumps({"active_id":"model-id","models":[{"id":"model-id","model_name":"example","engine":"fastembed","local_path":"C:\\old-computer\\data\\embedding-models\\imports\\model-id\\nested"}]}))
    assert Path(manager.active()["local_path"])==local.resolve()


def test_restore_initialization_failure_rolls_back_to_original_book(tmp_path):
    from reader_next_api.runtime import Runtime
    source,_=old_source(tmp_path/"source")
    archive=tmp_path/"source.zip";create_full_backup(source.root,archive)
    stage=tmp_path/"stage";inspect_backup(archive,stage)
    runtime=Runtime(tmp_path/"live",tmp_path)
    runtime.start()
    try:
        original=runtime.repository.add_document("原有教材.pdf",b"%PDF-1.7\noriginal")
        attempts=[]
        def fail_once(root):
            attempts.append(1)
            if len(attempts)==1: raise ValueError("模拟旧模型配置不可用")
            return Repository(root)
        runtime._repository_factory=fail_once
        with pytest.raises(RuntimeError,match="已回滚"):
            with runtime.lease(exclusive=True):
                runtime.restore(stage,runtime.data_root/"backups"/"safety.zip")
        assert runtime.repository.list_documents()[0]["id"]==original["id"]
        assert runtime.repository.document_path(original["id"]).read_bytes()==b"%PDF-1.7\noriginal"
    finally:
        runtime.stop()
