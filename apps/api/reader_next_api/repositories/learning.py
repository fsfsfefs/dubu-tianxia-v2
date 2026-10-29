from __future__ import annotations

import json
from uuid import uuid4


from ..chapters import chapter_key


class LearningRepository:
    def list_summary_gaps(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute("SELECT chapter_key,title,start_page,end_page,reason FROM summary_gaps WHERE document_id=? ORDER BY start_page", (document_id,)).fetchall()
        current = self.get_imported_outline(document_id)
        allowed = {chapter_key(document_id, current, i) for i in range(len(current))} | {f"{document_id}:__book__"}
        return [dict(row) for row in rows if not current or row["chapter_key"] in allowed]


    def save_summary_gap(self, document_id: str, key: str, title: str, start: int, end: int, reason: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute("INSERT INTO summary_gaps VALUES (?,?,?,?,?,?) ON CONFLICT(document_id,chapter_key) DO UPDATE SET title=excluded.title,start_page=excluded.start_page,end_page=excluded.end_page,reason=excluded.reason", (document_id,key,title,start,end,reason))
        return {"chapter_key": key, "title": title, "start_page": start, "end_page": end, "reason": reason}


    def summary_checkpoint(self, document_id: str, key: str) -> str | None:
        self.document_path(document_id)
        with self.connect() as connection:
            row = connection.execute(
                "SELECT content FROM summary_checkpoints WHERE document_id=? AND checkpoint_key=?",
                (document_id, key),
            ).fetchone()
        return row["content"] if row else None


    def save_summary_checkpoint(self, document_id: str, key: str, content: str) -> None:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO summary_checkpoints VALUES (?,?,?) "
                "ON CONFLICT(document_id,checkpoint_key) DO UPDATE SET content=excluded.content",
                (document_id, key, content),
            )


    def list_chapter_summaries(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT chapter_key, title, start_page, end_page, depth, content, updated_at
                   FROM chapter_summaries WHERE document_id = ? ORDER BY start_page, depth""",
                (document_id,),
            ).fetchall()
        return [dict(row) for row in rows]


    def save_chapter_summary(
        self, document_id: str, chapter_key: str, title: str, start_page: int,
        end_page: int, depth: int, content: str,
    ) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO chapter_summaries(
                     document_id,chapter_key,title,start_page,end_page,depth,content
                   ) VALUES (?,?,?,?,?,?,?)
                   ON CONFLICT(document_id,chapter_key) DO UPDATE SET
                     title=excluded.title, start_page=excluded.start_page,
                     end_page=excluded.end_page, depth=excluded.depth,
                     content=excluded.content, updated_at=CURRENT_TIMESTAMP""",
                (document_id, chapter_key, title, start_page, end_page, depth, content),
            )
            connection.execute("DELETE FROM summary_gaps WHERE document_id=? AND chapter_key=?", (document_id, chapter_key))
            row = connection.execute(
                """SELECT chapter_key, title, start_page, end_page, depth, content, updated_at
                   FROM chapter_summaries WHERE document_id = ? AND chapter_key = ?""",
                (document_id, chapter_key),
            ).fetchone()
        return dict(row)


    def get_imported_outline(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT title, page_number AS page, depth, source, updated_at
                   FROM document_outlines WHERE document_id = ? ORDER BY position""",
                (document_id,),
            ).fetchall()
        return [dict(row) for row in rows]


    def import_learning_structure(
        self, document_id: str, outline: list[dict], summaries: list[dict],
    ) -> dict:
        self.document_path(document_id)
        previous = self.get_imported_outline(document_id)
        if previous:
            self.reconcile_chapter_keys(document_id, previous)
        with self.connect() as connection:
            for table in ("chapter_summaries", "summary_gaps"):
                rows = connection.execute(f"SELECT chapter_key FROM {table} WHERE document_id=?", (document_id,)).fetchall()
                for row in rows:
                    if row["chapter_key"].removeprefix(document_id + ":").isdigit():
                        connection.execute(f"UPDATE {table} SET chapter_key=? WHERE document_id=? AND chapter_key=?", ("legacy:" + row["chapter_key"], document_id, row["chapter_key"]))
            connection.execute("DELETE FROM document_outlines WHERE document_id = ?", (document_id,))
            for position, item in enumerate(outline):
                connection.execute(
                    """INSERT INTO document_outlines(
                         document_id,position,title,page_number,depth,source
                       ) VALUES (?,?,?,?,?,'import')""",
                    (document_id, position, item["title"], item["page"], item["depth"]),
                )
            for summary in summaries:
                summary = dict(summary)
                suffix = summary["chapter_key"].removeprefix(document_id + ":")
                if suffix.isdigit() and int(suffix) < len(outline):
                    summary["chapter_key"] = chapter_key(document_id, outline, int(suffix))
                connection.execute(
                    """INSERT INTO chapter_summaries(
                         document_id,chapter_key,title,start_page,end_page,depth,content
                       ) VALUES (?,?,?,?,?,?,?)
                       ON CONFLICT(document_id,chapter_key) DO UPDATE SET
                         title=excluded.title, start_page=excluded.start_page,
                         end_page=excluded.end_page, depth=excluded.depth,
                         content=excluded.content, updated_at=CURRENT_TIMESTAMP""",
                    (
                        document_id, summary["chapter_key"], summary["title"],
                        summary["start_page"], summary["end_page"], summary["depth"],
                        summary["content"],
                    ),
                )
                connection.execute("DELETE FROM summary_gaps WHERE document_id=? AND chapter_key=?", (document_id, summary["chapter_key"]))
            outline_rows = connection.execute(
                """SELECT title, page_number AS page, depth, source, updated_at
                   FROM document_outlines WHERE document_id = ? ORDER BY position""",
                (document_id,),
            ).fetchall()
            summary_rows = connection.execute(
                """SELECT chapter_key, title, start_page, end_page, depth, content, updated_at
                   FROM chapter_summaries WHERE document_id = ? ORDER BY start_page, depth""",
                (document_id,),
            ).fetchall()
        return {
            "outline": [dict(row) for row in outline_rows],
            "summaries": [dict(row) for row in summary_rows],
        }


    def list_highlights(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM highlights WHERE document_id = ? ORDER BY created_at",
                (document_id,),
            ).fetchall()
        return [{**dict(row), "rects": json.loads(row["rects_json"]), "tags": json.loads(row["tags_json"])} for row in rows]


    def add_highlight(
        self, document_id: str, page_number: int, text: str, rects: list[dict], color: str,
        comment: str = "", tags: list[str] | None = None,
    ) -> dict:
        self.document_path(document_id)
        highlight_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO highlights(id,document_id,page_number,text,rects_json,color,comment,tags_json)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (highlight_id, document_id, page_number, text, json.dumps(rects), color, comment, json.dumps(tags or [], ensure_ascii=False)),
            )
            row = connection.execute(
                "SELECT * FROM highlights WHERE id = ?", (highlight_id,)
            ).fetchone()
        return {**dict(row), "rects": json.loads(row["rects_json"]), "tags": json.loads(row["tags_json"])}


    def update_highlight(self, document_id: str, highlight_id: str, color: str, comment: str, tags: list[str]) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE highlights SET color = ?, comment = ?, tags_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND document_id = ?",
                (color, comment, json.dumps(tags, ensure_ascii=False), highlight_id, document_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("高亮不存在。")
            row = connection.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,)).fetchone()
        return {**dict(row), "rects": json.loads(row["rects_json"]), "tags": json.loads(row["tags_json"])}


    def update_highlight_color(self, document_id: str, highlight_id: str, color: str) -> dict:
        current = next((item for item in self.list_highlights(document_id) if item["id"] == highlight_id), None)
        if current is None:
            raise LookupError("高亮不存在。")
        return self.update_highlight(document_id, highlight_id, color, current.get("comment", ""), current.get("tags", []))


    def delete_highlight(self, document_id: str, highlight_id: str) -> bool:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM highlights WHERE id = ? AND document_id = ?",
                (highlight_id, document_id),
            )
        return cursor.rowcount > 0


    def list_notes(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM notes WHERE document_id = ? ORDER BY pinned DESC, updated_at DESC, created_at DESC",
                (document_id,),
            ).fetchall()
        return [{**dict(row), "tags": json.loads(row["tags_json"]), "pinned": bool(row["pinned"])} for row in rows]


    def add_note(self, document_id: str, page_number: int | None, excerpt: str, content: str, title: str = "", tags: list[str] | None = None, pinned: bool = False) -> dict:
        self.document_path(document_id)
        note_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO notes(id,document_id,page_number,excerpt,content,title,tags_json,pinned) VALUES (?,?,?,?,?,?,?,?)",
                (note_id, document_id, page_number, excerpt, content, title, json.dumps(tags or [], ensure_ascii=False), int(pinned)),
            )
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return {**dict(row), "tags": json.loads(row["tags_json"]), "pinned": bool(row["pinned"])}


    def delete_note(self, document_id: str, note_id: str) -> bool:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM notes WHERE id = ? AND document_id = ?", (note_id, document_id)
            )
        return cursor.rowcount > 0


    def update_note(self, document_id: str, note_id: str, content: str, title: str = "", tags: list[str] | None = None, pinned: bool = False) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE notes SET content = ?, title = ?, tags_json = ?, pinned = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND document_id = ?",
                (content, title, json.dumps(tags or [], ensure_ascii=False), int(pinned), note_id, document_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("笔记不存在。")
            row = connection.execute("SELECT * FROM notes WHERE id = ?", (note_id,)).fetchone()
        return {**dict(row), "tags": json.loads(row["tags_json"]), "pinned": bool(row["pinned"])}


    def list_flashcards(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM flashcards WHERE document_id = ? ORDER BY created_at DESC, rowid DESC",
                (document_id,),
            ).fetchall()
        return [dict(row) for row in rows]


    def add_flashcards(self, document_id: str, page_number: int | None, source: str, cards: list[dict]) -> list[dict]:
        self.document_path(document_id)
        ids: list[str] = []
        with self.connect() as connection:
            for card in cards:
                card_id = str(uuid4())
                ids.append(card_id)
                connection.execute(
                    "INSERT INTO flashcards(id,document_id,page_number,question,answer,source_excerpt) VALUES (?,?,?,?,?,?)",
                    (card_id, document_id, page_number, card["question"], card["answer"], source),
                )
            placeholders = ",".join("?" for _ in ids)
            rows = connection.execute(
                f"SELECT * FROM flashcards WHERE id IN ({placeholders}) ORDER BY rowid", ids
            ).fetchall()
        return [dict(row) for row in rows]


    def add_flashcard(self, document_id: str, page_number: int | None, source: str, question: str, answer: str) -> dict:
        return self.add_flashcards(document_id, page_number, source, [{"question": question, "answer": answer}])[0]


    def update_flashcard(self, document_id: str, card_id: str, question: str, answer: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE flashcards SET question = ?, answer = ? WHERE id = ? AND document_id = ?",
                (question, answer, card_id, document_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("知识卡片不存在。")
            row = connection.execute("SELECT * FROM flashcards WHERE id = ?", (card_id,)).fetchone()
        return dict(row)


    def review_flashcard(self, document_id: str, card_id: str, mastered: bool) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                """UPDATE flashcards SET review_count = review_count + 1, mastered = ?,
                   last_reviewed_at = CURRENT_TIMESTAMP WHERE id = ? AND document_id = ?""",
                (int(mastered), card_id, document_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("知识卡片不存在。")
            row = connection.execute("SELECT * FROM flashcards WHERE id = ?", (card_id,)).fetchone()
        return dict(row)


    def delete_flashcard(self, document_id: str, card_id: str) -> bool:
        self.document_path(document_id)
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM flashcards WHERE id = ? AND document_id = ?", (card_id, document_id)
            )
        return cursor.rowcount > 0


    def list_chat_messages(self, document_id: str) -> list[dict]:
        self.document_path(document_id)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM chat_messages WHERE document_id = ? ORDER BY created_at, rowid",
                (document_id,),
            ).fetchall()
        return [dict(row) for row in rows]


    def add_chat_message(self, document_id: str, role: str, content: str) -> dict:
        self.document_path(document_id)
        message_id = str(uuid4())
        with self.connect() as connection:
            connection.execute(
                "INSERT INTO chat_messages(id,document_id,role,content) VALUES (?,?,?,?)",
                (message_id, document_id, role, content),
            )
            row = connection.execute(
                "SELECT * FROM chat_messages WHERE id = ?", (message_id,)
            ).fetchone()
        return dict(row)


    def clear_chat_messages(self, document_id: str) -> None:
        self.document_path(document_id)
        with self.connect() as connection:
            connection.execute("DELETE FROM chat_messages WHERE document_id = ?", (document_id,))


    def reconcile_chapter_keys(self, document_id: str, outline: list[dict]) -> None:
        """Copy compatible v1 positional records once, never repoint mismatched content."""
        with self.connect() as connection:
            for index, node in enumerate(outline):
                boundary = next((j for j in range(index + 1, len(outline)) if outline[j]["depth"] <= node["depth"]), len(outline))
                expected_end = max(node["page"], outline[boundary]["page"] - 1) if boundary < len(outline) else None
                old = f"{document_id}:{index}"
                new = chapter_key(document_id, outline, index)
                for table in ("chapter_summaries", "summary_gaps"):
                    row = connection.execute(f"SELECT * FROM {table} WHERE document_id=? AND chapter_key=?", (document_id, old)).fetchone()
                    if row is None or (row["title"], row["start_page"]) != (node["title"], node["page"]):
                        continue
                    if expected_end is not None and row["end_page"] != expected_end:
                        continue
                    if "depth" in row.keys() and row["depth"] != node["depth"]:
                        continue
                    columns = list(row.keys())
                    values = [new if col == "chapter_key" else row[col] for col in columns]
                    connection.execute(f"INSERT OR IGNORE INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", values)
                    connection.execute(f"DELETE FROM {table} WHERE document_id=? AND chapter_key=?", (document_id, old))
