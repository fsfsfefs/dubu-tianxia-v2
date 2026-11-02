"""Idempotent upgrades for persisted v1 learning records, without model calls."""
import json
from contextlib import closing
import sqlite3
from pathlib import Path

from pypdf import PdfReader
from .chapters import chapter_key
from .migrations import migrate


def _pdf_outline(path):
    with path.open("rb") as stream:
        reader = PdfReader(stream)
        outline = []
        def walk(items, depth=0):
            for item in items:
                if isinstance(item, list):
                    walk(item, depth + 1)
                else:
                    page = reader.get_destination_page_number(item)
                    if page is not None and page >= 0:
                        outline.append({"title": str(item.title), "page": page + 1, "depth": depth})
        walk(reader.outline)
        return outline


def normalize_legacy_chapters(connection, documents_dir, document_ids=None):
    report = {"chapters_upgraded": 0, "historical_records": 0, "outlines_recovered": 0}
    documents = connection.execute("SELECT id,filename FROM documents").fetchall()
    for document in documents:
        document_id = document["id"]
        if document_ids is not None and document_id not in document_ids:
            continue
        records = []
        for table in ("chapter_summaries", "summary_gaps"):
            for row in connection.execute(f"SELECT * FROM {table} WHERE document_id=?", (document_id,)):
                key = row["chapter_key"]
                suffix = key.removeprefix("legacy:").removeprefix(document_id + ":")
                if suffix.isdigit():
                    records.append((table, dict(row), int(suffix)))
        if not records:
            continue
        outline = [dict(row) for row in connection.execute("SELECT title,page_number AS page,depth FROM document_outlines WHERE document_id=? ORDER BY position", (document_id,))]
        if not outline:
            filename = document["filename"]
            if isinstance(filename, str) and Path(filename).name == filename:
                try:
                    outline = _pdf_outline(documents_dir / filename)
                except Exception:
                    # Missing/unreadable bookmarks never authorize guessing associations.
                    outline = []
            for position, node in enumerate(outline):
                connection.execute("INSERT INTO document_outlines(document_id,position,title,page_number,depth,source) VALUES (?,?,?,?,?,'pdf')",
                                   (document_id, position, node["title"], node["page"], node["depth"]))
            if outline:
                report["outlines_recovered"] += 1
        mapping = {}
        for table, row, index in records:
            matched = index < len(outline)
            if matched:
                node = outline[index]
                boundary = next((j for j in range(index + 1, len(outline)) if outline[j]["depth"] <= node["depth"]), len(outline))
                end = max(node["page"], outline[boundary]["page"] - 1) if boundary < len(outline) else None
                matched = (row["title"], row["start_page"]) == (node["title"], node["page"]) and (end is None or row["end_page"] == end)
                if table == "chapter_summaries":
                    matched = matched and row["depth"] == node["depth"]
            if not matched:
                report["historical_records"] += 1
                continue
            new_key = chapter_key(document_id, outline, index)
            existing = connection.execute(f"SELECT * FROM {table} WHERE document_id=? AND chapter_key=?", (document_id, new_key)).fetchone()
            if existing and any(existing[col] != row[col] for col in row if col not in {"chapter_key", "updated_at"}):
                report["historical_records"] += 1
                continue
            if not existing:
                connection.execute(f"UPDATE {table} SET chapter_key=? WHERE document_id=? AND chapter_key=?", (new_key, document_id, row["chapter_key"]))
            else:
                connection.execute(f"DELETE FROM {table} WHERE document_id=? AND chapter_key=?", (document_id, row["chapter_key"]))
            mapping[row["chapter_key"]] = new_key
            report["chapters_upgraded"] += 1
        if mapping:
            def remap(value):
                if isinstance(value, list):
                    return [remap(item) for item in value]
                if isinstance(value, dict):
                    return {key: mapping.get(item, item) if key == "chapter_key" and isinstance(item, str) else remap(item) for key, item in value.items()}
                return value
            for task in connection.execute("SELECT id,result_json FROM background_tasks WHERE document_id=?", (document_id,)).fetchall():
                try:
                    result = remap(json.loads(task["result_json"]))
                except (ValueError, TypeError):
                    continue
                connection.execute("UPDATE background_tasks SET result_json=? WHERE id=?", (json.dumps(result, ensure_ascii=False), task["id"]))
    return report


def upgrade_staged_database(staging):
    database = staging / "database" / "reader.db"
    try:
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA foreign_keys=ON")
            migrate(connection)
            if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise ValueError("旧备份数据库完整性检查失败。")
            for document in connection.execute("SELECT filename FROM documents"):
                filename = document["filename"]
                if not isinstance(filename, str) or Path(filename).name != filename or not (staging / "documents" / filename).is_file():
                    raise ValueError("旧备份缺少教材PDF或包含不安全的教材路径。")
            connection.execute("DROP TABLE IF EXISTS rag_chunks_fts")
            report = normalize_legacy_chapters(connection, staging / "documents")
            if connection.execute("PRAGMA foreign_key_check").fetchone():
                raise ValueError("旧备份包含无法归属的学习数据，已停止导入。")
            connection.execute("UPDATE background_tasks SET status='paused',cancel_requested=1,message='旧版任务已迁移并暂停，请确认模型配置后重新执行。' WHERE status IN ('queued','running','cancelling')")
        return report
    except (sqlite3.Error, RuntimeError) as error:
        raise ValueError(f"旧备份升级验证失败：{error}") from error
