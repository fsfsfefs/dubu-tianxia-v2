from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path
from uuid import uuid4


class DocumentsRepository:
    def list_documents(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM documents ORDER BY created_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]


    def list_folders(self) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT folder.id, folder.name, folder.created_at,
                          COUNT(document.id) AS document_count
                   FROM folders folder
                   LEFT JOIN documents document ON document.folder_id = folder.id
                   GROUP BY folder.id
                   ORDER BY folder.created_at, folder.name COLLATE NOCASE"""
            ).fetchall()
        return [dict(row) for row in rows]


    def create_folder(self, name: str) -> dict:
        clean_name = name.strip()[:80]
        if not clean_name:
            raise ValueError("文件夹名称不能为空。")
        folder_id = str(uuid4())
        try:
            with self.connect() as connection:
                connection.execute(
                    "INSERT INTO folders(id,name) VALUES (?,?)", (folder_id, clean_name)
                )
                row = connection.execute(
                    "SELECT id,name,created_at FROM folders WHERE id = ?", (folder_id,)
                ).fetchone()
        except sqlite3.IntegrityError as error:
            raise ValueError("已经存在同名文件夹。") from error
        return {**dict(row), "document_count": 0}


    def rename_folder(self, folder_id: str, name: str) -> dict:
        clean_name = name.strip()[:80]
        if not clean_name:
            raise ValueError("文件夹名称不能为空。")
        try:
            with self.connect() as connection:
                cursor = connection.execute(
                    "UPDATE folders SET name = ? WHERE id = ?", (clean_name, folder_id)
                )
                if cursor.rowcount == 0:
                    raise LookupError("文件夹不存在。")
                row = connection.execute(
                    """SELECT folder.id, folder.name, folder.created_at,
                              COUNT(document.id) AS document_count
                       FROM folders folder
                       LEFT JOIN documents document ON document.folder_id = folder.id
                       WHERE folder.id = ? GROUP BY folder.id""",
                    (folder_id,),
                ).fetchone()
        except sqlite3.IntegrityError as error:
            raise ValueError("已经存在同名文件夹。") from error
        return dict(row)


    def delete_folder(self, folder_id: str) -> None:
        with self.connect() as connection:
            exists = connection.execute(
                "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
            ).fetchone()
            if not exists:
                raise LookupError("文件夹不存在。")
            connection.execute("UPDATE documents SET folder_id = NULL WHERE folder_id = ?", (folder_id,))
            connection.execute("DELETE FROM folders WHERE id = ?", (folder_id,))


    def move_document(self, document_id: str, folder_id: str | None) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            if folder_id is not None:
                exists = connection.execute(
                    "SELECT 1 FROM folders WHERE id = ?", (folder_id,)
                ).fetchone()
                if not exists:
                    raise LookupError("目标文件夹不存在。")
            connection.execute(
                "UPDATE documents SET folder_id = ? WHERE id = ?", (folder_id, document_id)
            )
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        return dict(row)


    def add_document(self, filename: str, content: bytes) -> dict:
        if not filename.lower().endswith(".pdf") or not content.startswith(b"%PDF-"):
            raise ValueError("只接受有效的 PDF 文件。")
        digest = hashlib.sha256(content).hexdigest()
        with self.connect() as connection:
            existing = connection.execute(
                "SELECT * FROM documents WHERE sha256 = ?", (digest,)
            ).fetchone()
            if existing:
                return dict(existing)
            document_id = str(uuid4())
            safe_name = f"{document_id}.pdf"
            (self.documents_dir / safe_name).write_bytes(content)
            title = Path(filename).stem.strip()[:160] or "未命名文档"
            connection.execute(
                "INSERT INTO documents(id,title,filename,sha256,byte_size) VALUES (?,?,?,?,?)",
                (document_id, title, safe_name, digest, len(content)),
            )
            row = connection.execute(
                "SELECT * FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        return dict(row)


    def document_path(self, document_id: str) -> Path:
        with self.connect() as connection:
            row = connection.execute(
                "SELECT filename FROM documents WHERE id = ?", (document_id,)
            ).fetchone()
        if row is None:
            raise LookupError("文档不存在。")
        return self.documents_dir / row["filename"]


    def rename_document(self, document_id: str, title: str) -> dict:
        clean_title = title.strip()[:160]
        if not clean_title:
            raise ValueError("文档名称不能为空。")
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute("UPDATE documents SET title = ? WHERE id = ?", (clean_title, document_id))
            row = connection.execute("SELECT * FROM documents WHERE id = ?", (document_id,)).fetchone()
        return dict(row)


    def delete_document(self, document_id: str) -> None:
        path = self.document_path(document_id)
        with self.connect() as connection:
            connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
        path.unlink(missing_ok=True)


    def get_position(self, document_id: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            row = connection.execute(
                "SELECT page_number, page_offset, zoom, updated_at FROM reading_positions WHERE document_id = ?",
                (document_id,),
            ).fetchone()
        return dict(row) if row else {"page_number": 1, "page_offset": 0.0, "zoom": 1.0, "updated_at": None}


    def save_position(self, document_id: str, page_number: int, zoom: float, page_offset: float = 0.0) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO reading_positions(document_id,page_number,page_offset,zoom)
                   VALUES (?,?,?,?)
                   ON CONFLICT(document_id) DO UPDATE SET
                     page_number=excluded.page_number, page_offset=excluded.page_offset, zoom=excluded.zoom,
                     updated_at=CURRENT_TIMESTAMP""",
                (document_id, page_number, page_offset, zoom),
            )
        return self.get_position(document_id)


    def read_indexed_page(self, document_id: str, page_number: int) -> str:
        """Read bounded page context without loading an entire book."""
        self.document_path(document_id)
        with self.connect() as connection:
            row = connection.execute(
                "SELECT substr(text, 1, 2400) FROM ocr_pages WHERE document_id = ? AND page_number = ?",
                (document_id, page_number),
            ).fetchone()
        return str(row[0]) if row else ''


    def list_ocr_pages(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT page_number, text, updated_at FROM ocr_pages WHERE document_id = ? ORDER BY page_number",
                (document_id,),
            ).fetchall()
        return [dict(row) for row in rows]


    def save_ocr_page(self, document_id: str, page_number: int, text: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO ocr_pages(document_id,page_number,text) VALUES (?,?,?)
                   ON CONFLICT(document_id,page_number) DO UPDATE SET
                     text=excluded.text, updated_at=CURRENT_TIMESTAMP""",
                (document_id, page_number, text),
            )
            self._replace_rag_page(connection, document_id, page_number, text)
            row = connection.execute(
                "SELECT page_number, text, updated_at FROM ocr_pages WHERE document_id = ? AND page_number = ?",
                (document_id, page_number),
            ).fetchone()
        return dict(row)
