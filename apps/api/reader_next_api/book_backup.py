"""Portable, isolated backup of one textbook and its persisted learning records."""
import base64
import hashlib
import json
import shutil
import sqlite3
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .domain import ModelProfile
from .compatibility import normalize_legacy_chapters

FORMAT = "reader-next-book-backup"
TABLES = ("notes", "chat_messages", "reading_positions", "highlights", "flashcards",
          "ocr_pages", "summary_gaps", "summary_checkpoints", "chapter_summaries",
          "document_outlines", "background_tasks", "rag_chunks")
MAX_ARCHIVE = 1024 * 1024 * 1024
LIMITS = {"manifest.json": 65536, "book.json": 128 * 1024 * 1024, "document.pdf": 512 * 1024 * 1024}


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def create_book_backup(repo, document_id, destination, *, summary_profile_id=None):
    with repo.connect() as connection:
        connection.execute("BEGIN")
        document = connection.execute("SELECT * FROM documents WHERE id=?", (document_id,)).fetchone()
        if document is None:
            raise LookupError("教材不存在。")
        document = dict(document)
        tables = {table: [dict(row) for row in connection.execute(
            f"SELECT * FROM {table} WHERE document_id=?", (document_id,))] for table in TABLES}
        for row in tables["rag_chunks"]:
            if row["embedding"] is not None:
                row["embedding"] = base64.b64encode(row["embedding"]).decode()
        profile_ids = set()
        for row in tables["background_tasks"]:
            profile_id = json.loads(row["result_json"]).get("summary_request", {}).get("profile_id")
            if profile_id:
                profile_ids.add(profile_id)
        if summary_profile_id:
            profile_ids.add(summary_profile_id)
        profiles = [dict(row) for row in connection.execute("SELECT * FROM model_profiles") if row["id"] in profile_ids]
        folder = connection.execute("SELECT name FROM folders WHERE id=?", (document["folder_id"],)).fetchone()
        metadata = {"document": document, "tables": tables, "profiles": profiles,
                    "folder_name": folder["name"] if folder else None,
                    "summary_profile_id": summary_profile_id if any(item["id"] == summary_profile_id for item in profiles) else None}
    raw = json.dumps(metadata, ensure_ascii=False).encode()
    pdf = repo.document_path(document_id)
    if len(raw) > LIMITS["book.json"] or pdf.stat().st_size > LIMITS["document.pdf"]:
        raise ValueError("单书备份超过限制（PDF512MB，学习数据128MB）。")
    manifest = {"format": FORMAT, "version": 1, "credentials_included": False, "shared_models_included": False, "created_at": datetime.now(timezone.utc).isoformat(),
                "files": {"book.json": {"size": len(raw), "sha256": hashlib.sha256(raw).hexdigest()},
                          "document.pdf": {"size": pdf.stat().st_size, "sha256": digest(pdf)}}}
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(destination, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("book.json", raw)
        archive.write(pdf, "document.pdf")


def inspect_book_backup(path, staging):
    if path.stat().st_size > MAX_ARCHIVE:
        raise ValueError("单书备份ZIP不得超过1GB。")
    with zipfile.ZipFile(path) as archive:
        entries = archive.infolist()
        if len(entries) != 3 or {entry.filename for entry in entries} != set(LIMITS):
            raise ValueError("单书备份必须仅包含manifest.json、book.json和document.pdf。")
        for entry in entries:
            if entry.file_size > LIMITS[entry.filename] or entry.flag_bits & 1:
                raise ValueError("备份文件过大或已加密。")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest.get("format") != FORMAT or manifest.get("version") != 1:
            raise ValueError("请选择受支持的单书完整备份ZIP。")
        if set(manifest.get("files", {})) != {"book.json", "document.pdf"}:
            raise ValueError("备份清单无效。")
        staging.mkdir()
        for name in ("book.json", "document.pdf"):
            target = staging / name
            with archive.open(name) as source, target.open("wb") as output:
                shutil.copyfileobj(source, output, 1024 * 1024)
            info = manifest["files"][name]
            if target.stat().st_size != info.get("size") or digest(target) != info.get("sha256"):
                raise ValueError("单书备份校验失败。")
    data = json.loads((staging / "book.json").read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("tables"), dict) or set(data["tables"]) - set(TABLES):
        raise ValueError("单书数据表清单无效。")
    for table in TABLES:
        data["tables"].setdefault(table, [])
    document = data["document"]
    if not isinstance(document.get("id"), str) or not document["id"] or not isinstance(document.get("title"), str):
        raise ValueError("教材信息无效。")
    if document.get("sha256") != digest(staging / "document.pdf") or document.get("byte_size") != (staging / "document.pdf").stat().st_size:
        raise ValueError("教材PDF校验失败。")
    for table, rows in data["tables"].items():
        if not isinstance(rows, list) or len(rows) > 500_000:
            raise ValueError("学习数据数量异常。")
        if any(not isinstance(row, dict) or row.get("document_id") != document["id"] for row in rows):
            raise ValueError("备份含有其他教材的数据。")
    return data


def _insert(connection, table, row):
    columns = {item[1] for item in connection.execute(f"PRAGMA table_info({table})")}
    if not row or set(row) - columns:
        raise ValueError("单书数据字段或版本不受支持。")
    names = list(row)
    connection.execute(f"INSERT INTO {table} ({','.join(names)}) VALUES ({','.join('?' for _ in names)})",
                       [row[name] for name in names])


def _remap_result(value, old, new, profiles):
    if isinstance(value, list):
        return [_remap_result(item, old, new, profiles) for item in value]
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            if key == "profile_id" and isinstance(item, str):
                result[key] = profiles.get(item, item)
            elif key == "document_id" and item == old:
                result[key] = new
            elif key == "chapter_key" and isinstance(item, str) and item.removeprefix("legacy:").startswith(old + ":"):
                prefix = "legacy:" if item.startswith("legacy:") else ""
                plain = item.removeprefix(prefix)
                result[key] = prefix + new + plain[len(old):]
            else:
                result[key] = _remap_result(item, old, new, profiles)
        return result
    return value


def install_book_backup(repo, data, pdf, *, replace_existing=False):
    source = data["document"]
    if data.get("summary_profile_id") is not None and not isinstance(data["summary_profile_id"], str):
        raise ValueError("本书模型配置标识无效。")
    with repo.connect() as connection:
        existing = connection.execute("SELECT * FROM documents WHERE sha256=?", (source["sha256"],)).fetchone()
    if existing and not replace_existing:
        raise ValueError("已存在相同PDF；请允许替换该书学习数据后重试。")
    document_id = existing["id"] if existing else str(uuid4())
    filename = existing["filename"] if existing else document_id + ".pdf"
    target = repo.documents_dir / filename
    created_file = False
    safety = None
    if existing:
        safety = repo.root / "backups" / ("pre-book-import-" + uuid4().hex + ".zip")
        create_book_backup(repo, document_id, safety)
    try:
        if not existing:
            with target.open("xb") as output, pdf.open("rb") as source_pdf:
                created_file = True
                shutil.copyfileobj(source_pdf, output, 1024 * 1024)
        with repo.retrieval.lock, repo.connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            profiles = {}
            for item in data.get("profiles", []):
                profile = ModelProfile(**{key: item[key] for key in ("id", "name", "endpoint", "model", "temperature", "max_tokens")})
                profile.validate()
                match = connection.execute("SELECT id FROM model_profiles WHERE endpoint=? AND model=? AND temperature=? AND max_tokens=?",
                                           (profile.endpoint, profile.model, profile.temperature, profile.max_tokens)).fetchone()
                occupied = connection.execute("SELECT id FROM model_profiles WHERE id=?", (profile.id,)).fetchone()
                new_id = match["id"] if match else str(uuid4()) if occupied else profile.id
                profiles[profile.id] = new_id
                if not match:
                    _insert(connection, "model_profiles", {"id": new_id, "name": profile.name, "endpoint": profile.endpoint,
                        "model": profile.model, "temperature": profile.temperature, "max_tokens": profile.max_tokens, "is_default": 0})
            folder_id = existing["folder_id"] if existing else None
            folder_name = data.get("folder_name")
            if not existing and folder_name:
                if not isinstance(folder_name, str) or len(folder_name) > 80:
                    raise ValueError("文件夹名称无效。")
                folder = connection.execute("SELECT id FROM folders WHERE name=? COLLATE NOCASE", (folder_name,)).fetchone()
                folder_id = folder["id"] if folder else str(uuid4())
                if not folder:
                    _insert(connection, "folders", {"id": folder_id, "name": folder_name})
            if existing:
                for table in TABLES:
                    connection.execute(f"DELETE FROM {table} WHERE document_id=?", (document_id,))
                if repo.rag_fts_available:
                    connection.execute("DELETE FROM rag_chunks_fts WHERE document_id=?", (document_id,))
                connection.execute("UPDATE documents SET title=?,byte_size=? WHERE id=?", (source["title"], source["byte_size"], document_id))
            else:
                _insert(connection, "documents", {"id": document_id, "filename": filename, "title": source["title"],
                    "sha256": source["sha256"], "byte_size": source["byte_size"], "folder_id": folder_id,
                    "created_at": source.get("created_at", datetime.now(timezone.utc).isoformat())})
            for table in TABLES:
                for original in data["tables"][table]:
                    row = dict(original)
                    row["document_id"] = document_id
                    if "id" in row:
                        row["id"] = str(uuid4())
                    if "chapter_key" in row:
                        key = row["chapter_key"]
                        prefix = "legacy:" if isinstance(key, str) and key.startswith("legacy:") else ""
                        plain = key.removeprefix(prefix) if isinstance(key, str) else ""
                        if not plain.startswith(source["id"] + ":"):
                            raise ValueError("章节标识与教材不匹配。")
                        row["chapter_key"] = prefix + document_id + plain[len(source["id"]):]
                    if table == "background_tasks":
                        row["result_json"] = json.dumps(_remap_result(json.loads(row.get("result_json", "{}")), source["id"], document_id, profiles), ensure_ascii=False)
                        if row["status"] in {"queued", "running", "cancelling", "paused"}:
                            row.update(status="paused", cancel_requested=1, message="从单书备份导入，已暂停；确认模型配置后重新执行。")
                    if table == "rag_chunks" and row.get("embedding") is not None:
                        row["embedding"] = base64.b64decode(row["embedding"], validate=True)
                    _insert(connection, table, row)
                    if table == "rag_chunks" and repo.rag_fts_available:
                        connection.execute("INSERT INTO rag_chunks_fts(chunk_id,document_id,page_number,content) VALUES (?,?,?,?)",
                                           (row["id"], document_id, row["page_number"], row["content"]))
            missing_pages = connection.execute("""SELECT page_number,text FROM ocr_pages p WHERE document_id=?
                AND NOT EXISTS (SELECT 1 FROM rag_chunks r WHERE r.document_id=p.document_id AND r.page_number=p.page_number)""", (document_id,)).fetchall()
            for page in missing_pages:
                if page["text"].strip():
                    repo._replace_rag_page(connection, document_id, page["page_number"], page["text"])
            compatibility = normalize_legacy_chapters(connection, repo.documents_dir, {document_id})
            # Recompute only this book's incompatible vectors using the current local model.
            rows = connection.execute("SELECT id,content FROM rag_chunks WHERE document_id=? AND (embedding IS NULL OR embedding_model IS NULL OR embedding_model!=?)",
                                      (document_id, repo.embedding_models.active_key)).fetchall()
            if rows:
                vectors = repo.embedding_models.embed_passages([row["content"] for row in rows])
                repo.write_rag_vectors(connection, rows, vectors, repo.embedding_models.active_key)
    except Exception:
        if created_file:
            target.unlink(missing_ok=True)
        raise
    return {"compatibility": compatibility, "document_id": document_id, "replaced": bool(existing), "safety_backup": safety.name if safety else None,
            "summary_profile_id": profiles.get(data.get("summary_profile_id")),
            "counts": {table: len(rows) for table, rows in data["tables"].items()},
            "message": "单书全部学习数据已导入。API Key与共享模型文件不包含在包内；导入的未结束任务保持暂停。"}
