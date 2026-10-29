from __future__ import annotations

import json
import sqlite3
from uuid import uuid4


class TasksRepository:
    @staticmethod
    def _background_task(row: sqlite3.Row | None) -> dict | None:
        if row is None:
            return None
        task = dict(row)
        task["cancel_requested"] = bool(task["cancel_requested"])
        try:
            task["result"] = json.loads(task.pop("result_json"))
        except (TypeError, ValueError):
            task["result"] = {}
            task.pop("result_json", None)
        return task


    def list_background_tasks(self, limit: int = 100) -> list[dict]:
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT task.*, document.title AS document_title
                   FROM background_tasks task
                   LEFT JOIN documents document ON document.id = task.document_id
                   ORDER BY task.created_at DESC, task.rowid DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        return [self._background_task(row) for row in rows]


    def background_task(self, task_id: str) -> dict:
        with self.connect() as connection:
            row = connection.execute(
                """SELECT task.*, document.title AS document_title
                   FROM background_tasks task
                   LEFT JOIN documents document ON document.id = task.document_id
                   WHERE task.id = ?""",
                (task_id,),
            ).fetchone()
        task = self._background_task(row)
        if task is None:
            raise LookupError("后台任务不存在。")
        return task


    def create_background_task(self, task_type: str, document_id: str, title: str) -> dict:
        self.document_path(document_id)
        with self.connect() as connection:
            existing = connection.execute(
                """SELECT id FROM background_tasks
                   WHERE task_type = ? AND document_id = ?
                     AND status IN ('queued','running','cancelling')
                   ORDER BY created_at DESC LIMIT 1""",
                (task_type, document_id),
            ).fetchone()
            if existing:
                return self.background_task(existing["id"])
            task_id = str(uuid4())
            connection.execute(
                """INSERT INTO background_tasks(id,task_type,document_id,title,status,message)
                   VALUES (?,?,?,?,'queued','等待后台处理')""",
                (task_id, task_type, document_id, title),
            )
        return self.background_task(task_id)


    def update_background_task(self, task_id: str, **changes) -> dict:
        allowed = {"status", "progress", "total", "message", "error", "cancel_requested"}
        fields = {key: value for key, value in changes.items() if key in allowed}
        if "result" in changes:
            fields["result_json"] = json.dumps(changes["result"], ensure_ascii=False)
        if not fields:
            return self.background_task(task_id)
        assignments = ", ".join(f"{field} = ?" for field in fields)
        values = list(fields.values())
        with self.connect() as connection:
            cursor = connection.execute(
                f"UPDATE background_tasks SET {assignments}, updated_at=CURRENT_TIMESTAMP WHERE id = ?",
                (*values, task_id),
            )
            if cursor.rowcount == 0:
                raise LookupError("后台任务不存在。")
        return self.background_task(task_id)


    def request_background_task_cancel(self, task_id: str) -> dict:
        task = self.background_task(task_id)
        if task["status"] not in {"queued", "running", "cancelling"}:
            return task
        return self.update_background_task(
            task_id, status="cancelling", cancel_requested=1, message="正在取消…",
        )


    def recover_background_tasks(self) -> None:
        with self.connect() as connection:
            connection.execute(
                """UPDATE background_tasks
                   SET status='paused', message='服务曾重启，可点击重新执行',
                       cancel_requested=0, updated_at=CURRENT_TIMESTAMP
                   WHERE status IN ('queued','running','cancelling')"""
            )


    def clear_finished_background_tasks(self) -> int:
        with self.connect() as connection:
            cursor = connection.execute(
                "DELETE FROM background_tasks WHERE status IN ('completed','partial','failed','cancelled')"
            )
        return cursor.rowcount
