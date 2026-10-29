from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from ..embedding_models import EmbeddingModelManager


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  byte_size INTEGER NOT NULL,
  folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS model_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  temperature REAL NOT NULL,
  max_tokens INTEGER NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER,
  excerpt TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  pinned INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reading_positions (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL DEFAULT 1,
  page_offset REAL NOT NULL DEFAULT 0.0,
  zoom REAL NOT NULL DEFAULT 1.0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL,
  rects_json TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'yellow',
  comment TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS flashcards (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  source_excerpt TEXT NOT NULL DEFAULT '',
  review_count INTEGER NOT NULL DEFAULT 0,
  mastered INTEGER NOT NULL DEFAULT 0,
  last_reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ocr_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(document_id, page_number)
);
CREATE TABLE IF NOT EXISTS summary_gaps (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chapter_key TEXT NOT NULL,
  title TEXT NOT NULL,
  start_page INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(document_id, chapter_key)
);
CREATE TABLE IF NOT EXISTS summary_checkpoints (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  checkpoint_key TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY(document_id, checkpoint_key)
);
CREATE TABLE IF NOT EXISTS chapter_summaries (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chapter_key TEXT NOT NULL,
  title TEXT NOT NULL,
  start_page INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(document_id, chapter_key)
);
CREATE TABLE IF NOT EXISTS document_outlines (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT NOT NULL,
  page_number INTEGER NOT NULL,
  depth INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'import',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(document_id, position)
);
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  task_type TEXT NOT NULL,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT '',
  result_json TEXT NOT NULL DEFAULT '{}',
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS background_tasks_status
  ON background_tasks(status, created_at);
CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding BLOB,
  embedding_model TEXT,
  UNIQUE(document_id, page_number, chunk_index)
);
CREATE INDEX IF NOT EXISTS rag_chunks_document_page
  ON rag_chunks(document_id, page_number);
"""


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
        self.embedding_models = EmbeddingModelManager(root)
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(flashcards)")}
            if "review_count" not in columns:
                connection.execute("ALTER TABLE flashcards ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0")
            if "mastered" not in columns:
                connection.execute("ALTER TABLE flashcards ADD COLUMN mastered INTEGER NOT NULL DEFAULT 0")
            if "last_reviewed_at" not in columns:
                connection.execute("ALTER TABLE flashcards ADD COLUMN last_reviewed_at TEXT")
            document_columns = {row["name"] for row in connection.execute("PRAGMA table_info(documents)")}
            if "folder_id" not in document_columns:
                connection.execute("ALTER TABLE documents ADD COLUMN folder_id TEXT")
            position_columns = {row["name"] for row in connection.execute("PRAGMA table_info(reading_positions)")}
            if "page_offset" not in position_columns:
                connection.execute("ALTER TABLE reading_positions ADD COLUMN page_offset REAL NOT NULL DEFAULT 0.0")
            rag_columns = {row["name"] for row in connection.execute("PRAGMA table_info(rag_chunks)")}
            if "embedding" not in rag_columns:
                connection.execute("ALTER TABLE rag_chunks ADD COLUMN embedding BLOB")
            if "embedding_model" not in rag_columns:
                connection.execute("ALTER TABLE rag_chunks ADD COLUMN embedding_model TEXT")
            note_columns = {row["name"] for row in connection.execute("PRAGMA table_info(notes)")}
            for name, definition in {
                "title": "TEXT NOT NULL DEFAULT ''",
                "tags_json": "TEXT NOT NULL DEFAULT '[]'",
                "pinned": "INTEGER NOT NULL DEFAULT 0",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if name not in note_columns:
                    connection.execute(f"ALTER TABLE notes ADD COLUMN {name} {definition}")
            highlight_columns = {row["name"] for row in connection.execute("PRAGMA table_info(highlights)")}
            for name, definition in {
                "comment": "TEXT NOT NULL DEFAULT ''",
                "tags_json": "TEXT NOT NULL DEFAULT '[]'",
                "updated_at": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if name not in highlight_columns:
                    connection.execute(f"ALTER TABLE highlights ADD COLUMN {name} {definition}")
            self._initialize_rag_index(connection)
            self._backfill_rag_index(connection)
            self._backfill_rag_vectors(connection)


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
