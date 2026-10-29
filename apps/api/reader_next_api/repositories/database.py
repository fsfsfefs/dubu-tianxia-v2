from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ..migrations import migrate


class ManagedConnection(sqlite3.Connection):
    """Commit/rollback and deterministically close the connection."""
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class DatabaseRepository:
    def __init__(self, root: Path):
        self.root = root
        self.documents_dir = root / "documents"
        self.documents_dir.mkdir(parents=True, exist_ok=True)
        self.database_path = root / "reader.db"
        with self.connect() as connection:
            migrate(connection)
            self._initialize_rag_index(connection)



    def connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, factory=ManagedConnection)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection


    def export_data(self) -> dict:
        tables = ["folders", "documents", "model_profiles", "notes", "chat_messages", "reading_positions", "highlights", "flashcards", "ocr_pages", "summary_gaps", "summary_checkpoints", "chapter_summaries", "document_outlines", "rag_chunks"]
        with self.connect() as connection:
            result = {table: [dict(row) for row in connection.execute(f"SELECT * FROM {table}").fetchall()] for table in tables}
        for item in result["highlights"]:
            item["rects"] = json.loads(item.pop("rects_json"))
            item["tags"] = json.loads(item.pop("tags_json"))
        for item in result["notes"]:
            item["tags"] = json.loads(item.pop("tags_json"))
            item["pinned"] = bool(item["pinned"])
        for item in result["model_profiles"]:
            item["is_default"] = bool(item["is_default"])
        return result
