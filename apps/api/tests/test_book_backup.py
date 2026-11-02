import json
import sqlite3
import zipfile
from concurrent.futures import Future

import pytest
from fastapi.testclient import TestClient

from reader_next_api.repository import Repository
from reader_next_api.application import create_app
from reader_next_api.book_backup import TABLES, create_book_backup, inspect_book_backup, install_book_backup


def seed(root):
    repo = Repository(root)
    doc = repo.add_document("教材.pdf", b"%PDF-1.7\nbook fixture")
    other = repo.add_document("其他书.pdf", b"%PDF-1.7\nPRIVATE OTHER BOOK")
    folder=repo.create_folder("课程")
    repo.move_document(doc["id"],folder["id"])
    key = doc["id"] + ":__book__"
    repo.add_note(doc["id"], 2, "摘录", "笔记", "标题", ["复习"], True)
    repo.add_highlight(doc["id"], 2, "手写", [{"x":.1,"y":.1,"width":0,"height":0}], "red", "备注", [])
    repo.save_ocr_page(doc["id"], 2, "虚拟内存与缺页中断的详细原文")
    repo.save_summary_checkpoint(doc["id"], "hash", "断点")
    repo.save_summary_gap(doc["id"], key, "待补章", 1, 2, "content_filter")
    rows = {
        "chat_messages":{"id":"chat","role":"user","content":"长期对话"},
        "reading_positions":{"page_number":2,"zoom":1.5,"page_offset":.3},
        "flashcards":{"id":"card","question":"问题","answer":"答案","review_count":3,"mastered":1},
        "chapter_summaries":{"chapter_key":key,"title":"全书","start_page":1,"end_page":2,"depth":0,"content":"总结"},
        "document_outlines":{"position":0,"title":"章节","page_number":1,"depth":0},
        "background_tasks":{"id":"task","task_type":"structure-summary","title":"总结","status":"running","result_json":json.dumps({"summary_request":{"profile_id":"p","chapter_index":None,"outline":[{"title":"章节","page":1,"depth":0}]},"missing_chapters":[{"chapter_key":key}]})},
    }
    with repo.connect() as c:
        c.execute("INSERT INTO model_profiles(id,name,endpoint,model,temperature,max_tokens) VALUES ('p','模型','https://example.com/chat/completions','model',0.2,2048)")
        for table,row in rows.items():
            row["document_id"]=doc["id"]
            c.execute(f"INSERT INTO {table} ({','.join(row)}) VALUES ({','.join('?' for _ in row)})",list(row.values()))
    return repo,doc,other


def package(tmp_path):
    repo,doc,other=seed(tmp_path/"source")
    archive=tmp_path/"book.zip"
    create_book_backup(repo,doc["id"],archive,summary_profile_id="p")
    staging=tmp_path/"stage"
    data=inspect_book_backup(archive,staging)
    return repo,doc,other,archive,staging,data


def test_all_book_tables_roundtrip_and_other_books_are_isolated(tmp_path):
    source,doc,other,archive,stage,data=package(tmp_path)
    with zipfile.ZipFile(archive) as z:
        raw=z.read("book.json")
        assert other["id"].encode() not in raw and b"PRIVATE OTHER BOOK" not in raw
        assert set(z.namelist())=={"manifest.json","book.json","document.pdf"}
    target=Repository(tmp_path/"target")
    unrelated=target.add_document("其他书.pdf",b"%PDF-1.7\nexisting unrelated")
    target.add_note(unrelated["id"],1,"","保留的笔记")
    report=install_book_backup(target,data,stage/"document.pdf")
    imported=report["document_id"]
    assert imported != doc["id"]
    assert report["summary_profile_id"]=="p"
    assert target.list_folders()[0]["name"]=="课程"
    assert target.document_path(imported).read_bytes()==source.document_path(doc["id"]).read_bytes()
    with target.connect() as c:
        for table in TABLES:
            assert c.execute(f"SELECT COUNT(*) FROM {table} WHERE document_id=?",(imported,)).fetchone()[0] == len(data["tables"][table])
        assert c.execute("PRAGMA foreign_key_check").fetchall()==[]
        task=dict(c.execute("SELECT * FROM background_tasks WHERE document_id=?",(imported,)).fetchone())
        assert task["status"]=="paused"
        options=json.loads(task["result_json"])
        assert options["missing_chapters"][0]["chapter_key"]==imported+":__book__"
        assert c.execute("SELECT id FROM model_profiles WHERE id=?",(options["summary_request"]["profile_id"],)).fetchone()
    assert target.list_notes(unrelated["id"])[0]["content"]=="保留的笔记"
    assert target.list_notes(imported)[0]["pinned"]
    assert target.get_position(imported)["page_offset"]==.3
    assert target.search_rag(imported,"虚拟内存")
    with pytest.raises(ValueError,match="相同PDF"):
        install_book_backup(target,data,stage/"document.pdf")
    target.add_note(imported,1,"","替换前的额外笔记")
    second=install_book_backup(target,data,stage/"document.pdf",replace_existing=True)
    assert second["document_id"]==imported and second["replaced"]
    assert len(target.list_notes(imported))==1
    safety=target.root/"backups"/second["safety_backup"]
    saved=inspect_book_backup(safety,tmp_path/"safety")
    assert len(saved["tables"]["notes"])==2


def test_import_error_rolls_back_existing_book_and_new_files(tmp_path):
    _,_,_,_,stage,data=package(tmp_path)
    target=Repository(tmp_path/"target")
    first=install_book_backup(target,data,stage/"document.pdf")
    target.add_note(first["document_id"],1,"","不得丢失")
    data["tables"]["notes"][0]["unknown_column"]="bad"
    with pytest.raises(ValueError):
        install_book_backup(target,data,stage/"document.pdf",replace_existing=True)
    assert len(target.list_notes(first["document_id"]))==2
    empty=Repository(tmp_path/"empty")
    with pytest.raises(ValueError):
        install_book_backup(empty,data,stage/"document.pdf")
    assert empty.list_documents()==[] and list(empty.documents_dir.iterdir())==[]
    with empty.connect() as c:
        assert c.execute("SELECT COUNT(*) FROM model_profiles").fetchone()[0]==0
        assert c.execute("SELECT COUNT(*) FROM folders").fetchone()[0]==0


@pytest.mark.parametrize("attack",["traversal","duplicate","tamper","other-book"])
def test_archive_validation_rejects_unsafe_or_mixed_data(tmp_path,attack):
    _,_,_,archive,_,_=package(tmp_path)
    with zipfile.ZipFile(archive) as z:
        parts={n:z.read(n) for n in z.namelist()}
    if attack=="traversal": parts["../evil"]="bad"
    if attack=="tamper": parts["document.pdf"]=b"changed"
    if attack=="other-book":
        import hashlib
        data=json.loads(parts["book.json"])
        data["tables"]["notes"][0]["document_id"]="other"
        parts["book.json"]=json.dumps(data).encode()
        manifest=json.loads(parts["manifest.json"])
        manifest["files"]["book.json"]={"size":len(parts["book.json"]),"sha256":hashlib.sha256(parts["book.json"]).hexdigest()}
        parts["manifest.json"]=json.dumps(manifest).encode()
    bad=tmp_path/"bad.zip"
    with zipfile.ZipFile(bad,"w") as z:
        for name,content in parts.items(): z.writestr(name,content)
        if attack=="duplicate": z.writestr("document.pdf",parts["document.pdf"])
    with pytest.raises(ValueError):
        inspect_book_backup(bad,tmp_path/"bad-stage")


def test_book_backup_api_and_active_task_guard(tmp_path):
    with TestClient(create_app(tmp_path/"api")) as client:
        runtime=client.app.state.runtime
        repo=runtime.repository
        doc=repo.add_document("book.pdf",b"%PDF-1.7\napi")
        repo.add_note(doc["id"],1,"","api note")
        response=client.get("/api/backup/book/"+doc["id"])
        assert response.status_code==200
        task=repo.create_background_task("structure-summary",doc["id"],"test")
        future=Future()
        runtime.task_manager._futures[task["id"]]=future
        assert client.get("/api/backup/book/"+doc["id"]).status_code==409
        assert client.post("/api/backup/book",files={"file":("book.zip",response.content,"application/zip")},data={"replace_existing":"true"}).status_code==409
        future.set_result(None);runtime.task_manager._futures.pop(task["id"])
        assert client.post("/api/backup/book",files={"file":("book.zip",response.content,"application/zip")}).status_code==409
        imported=client.post("/api/backup/book",files={"file":("book.zip",response.content,"application/zip")},data={"replace_existing":"true"})
        assert imported.status_code==200 and imported.json()["replaced"]
        assert repo.list_notes(doc["id"])[0]["content"]=="api note"
        assert not list(runtime.data_root.glob(".book-*"))

def test_import_preserves_conflicting_model_and_rebuilds_only_book_vectors(tmp_path):
    _,_,_,_,stage,data=package(tmp_path)
    target=Repository(tmp_path/"target")
    other=target.add_document("other.pdf",b"%PDF-1.7\nother")
    target.save_ocr_page(other["id"],1,"其他教材的原文")
    with target.connect() as c:
        c.execute("INSERT INTO model_profiles(id,name,endpoint,model,temperature,max_tokens) VALUES ('p','原有模型','https://other.example/chat/completions','other',0.2,2048)")
        original_vectors=[tuple(r) for r in c.execute("SELECT id,embedding,embedding_model FROM rag_chunks WHERE document_id=?",(other["id"],))]
    for row in data["tables"]["rag_chunks"]:
        row["embedding_model"]="unavailable-source-model"
    report=install_book_backup(target,data,stage/"document.pdf")
    assert report["summary_profile_id"]!="p"
    with target.connect() as c:
        assert c.execute("SELECT model FROM model_profiles WHERE id='p'").fetchone()[0]=="other"
        assert [tuple(r) for r in c.execute("SELECT id,embedding,embedding_model FROM rag_chunks WHERE document_id=?",(other["id"],))]==original_vectors
        assert all(r[0]==target.embedding_models.active_key for r in c.execute("SELECT embedding_model FROM rag_chunks WHERE document_id=?",(report["document_id"],)))
    assert target.search_rag(report["document_id"],"虚拟内存")
