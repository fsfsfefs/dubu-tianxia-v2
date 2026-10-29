from __future__ import annotations

import asyncio
import threading

from .summary_tasks import run_summary, SummaryStopped, SummaryPacer
from .providers import provider_error_message
from concurrent.futures import Future, ThreadPoolExecutor

from pypdf import PdfReader

from .repository import Repository


class BackgroundTaskManager:
    """Run durable local indexing jobs outside request handlers."""

    def __init__(self, repository: Repository, provider=None, credential_store=None) -> None:
        self.summary_pacer = SummaryPacer()
        self.provider = provider
        self.credential_store = credential_store
        self.repository = repository
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="reader-index")
        self._lock = threading.RLock()
        self._futures: dict[str, Future] = {}
        self.repository.recover_background_tasks()

    def shutdown(self) -> None:
        for task in self.repository.list_background_tasks():
            if task["status"] in {"queued", "running"}:
                try:
                    self.repository.request_background_task_cancel(task["id"])
                except LookupError:
                    pass
        self.executor.shutdown(wait=True, cancel_futures=True)

    def list(self) -> list[dict]:
        return self.repository.list_background_tasks()

    def enqueue_index(self, document_id: str, *, force: bool = False) -> dict:
        document = next(
            (item for item in self.repository.list_documents() if item["id"] == document_id),
            None,
        )
        if document is None:
            raise LookupError("文档不存在。")
        task = self.repository.create_background_task(
            "document-index", document_id, f"索引《{document['title']}》",
        )
        with self._lock:
            future = self._futures.get(task["id"])
            if future is None or future.done():
                self._futures[task["id"]] = self.executor.submit(
                    self._run_document_index, task["id"], document_id, force,
                )
        return self.repository.background_task(task["id"])

    def enqueue_summary(self, document_id: str, options: dict) -> dict:
        with self._lock:
            task = self.repository.create_background_task("structure-summary", document_id, "生成全书结构" if options["chapter_index"] is None else f"生成章节结构：{options['outline'][options['chapter_index']]['title']}")
            future = self._futures.get(task["id"])
            if future is not None and not future.done():
                return task
            self.repository.update_background_task(task["id"], result={"summary_request": options})
            self._futures[task["id"]] = self.executor.submit(self._run_summary, task["id"], options)
        return self.repository.background_task(task["id"])

    def pause(self, task_id: str) -> dict:
        task = self.repository.background_task(task_id)
        if task["task_type"] != "structure-summary":
            raise ValueError("只有总结任务支持暂停。")
        if task["status"] not in {"queued", "running"}:
            return task
        return self.repository.update_background_task(task_id, status="paused", cancel_requested=1, message="已请求暂停；正在结束当前调用，已完成分块将保留。")

    def _run_summary(self, task_id: str, options: dict) -> None:
        try:
            task = self.repository.background_task(task_id)
            if task["cancel_requested"] or task["status"] == "paused":
                raise SummaryStopped()
            self.repository.update_background_task(task_id, status="running", message="准备生成总结…", error="")
            asyncio.run(run_summary(self.repository, task_id, options, self.provider, self.credential_store, self.summary_pacer))
        except Exception as error:
            try:
                current = self.repository.background_task(task_id)
                if isinstance(error, SummaryStopped) or current["cancel_requested"]:
                    state = "paused" if current["status"] == "paused" else "cancelled"
                    self.repository.update_background_task(task_id, status=state, message="已暂停；已完成分块已保留。" if state == "paused" else "已取消；已完成分块已保留。")
                else:
                    self.repository.update_background_task(task_id, status="failed", message=f"总结失败（{current['message']}）；已完成分块保留。", error=provider_error_message(error))
            except LookupError:
                pass
        finally:
            with self._lock:
                self._futures.pop(task_id, None)

    def cancel(self, task_id: str) -> dict:
        task = self.repository.background_task(task_id)
        if task["task_type"] == "structure-summary" and task["status"] == "paused":
            return self.repository.update_background_task(task_id, status="cancelled", cancel_requested=1, message="已取消；已完成分块已保留。")
        return self.repository.request_background_task_cancel(task_id)

    def retry(self, task_id: str) -> dict:
        task = self.repository.background_task(task_id)
        if task["task_type"] == "structure-summary" and task.get("document_id"):
            if task["status"] in {"queued", "running", "cancelling"}:
                return task
            return self.enqueue_summary(task["document_id"], task["result"]["summary_request"])
        if task["task_type"] != "document-index" or not task.get("document_id"):
            raise ValueError("该任务不支持重新执行。")
        if task["status"] in {"queued", "running", "cancelling"}:
            return task
        return self.enqueue_index(task["document_id"], force=task["status"] == "failed")

    def clear_finished(self) -> int:
        return self.repository.clear_finished_background_tasks()

    def _cancelled(self, task_id: str) -> bool:
        try:
            return bool(self.repository.background_task(task_id)["cancel_requested"])
        except LookupError:
            return True

    def _run_document_index(self, task_id: str, document_id: str, force: bool) -> None:
        try:
            if self._cancelled(task_id):
                self.repository.update_background_task(
                    task_id, status="cancelled", message="任务已取消。",
                )
                return
            self.repository.update_background_task(
                task_id, status="running", progress=0, total=0,
                message="正在打开 PDF…", error="",
            )
            path = self.repository.document_path(document_id)
            reader = PdfReader(str(path))
            total = len(reader.pages)
            existing = {
                item["page_number"]: item["text"]
                for item in self.repository.list_ocr_pages(document_id)
                if item["text"].strip()
            }
            indexed = 0
            reused = 0
            blank = 0
            self.repository.update_background_task(
                task_id, total=total, message=f"准备索引 {total} 页…",
            )
            for offset, page in enumerate(reader.pages, 1):
                if self._cancelled(task_id):
                    self.repository.update_background_task(
                        task_id, status="cancelled", progress=offset - 1,
                        message="任务已取消；已完成的页面索引已保留。",
                    )
                    return
                if not force and existing.get(offset):
                    reused += 1
                else:
                    text = (page.extract_text() or "").strip()
                    if text:
                        self.repository.save_ocr_page(document_id, offset, text)
                        indexed += 1
                    else:
                        blank += 1
                self.repository.update_background_task(
                    task_id, progress=offset,
                    message=f"正在索引 PDF 第 {offset}/{total} 页",
                )
            message = f"索引完成：新增 {indexed} 页，复用 {reused} 页"
            if blank:
                message += f"；{blank} 页没有文字层，可在阅读页使用 OCR 补充"
            self.repository.update_background_task(
                task_id, status="completed", progress=total, total=total,
                message=message,
                result={"indexed_pages": indexed, "reused_pages": reused, "blank_pages": blank},
            )
        except Exception as error:
            self.repository.update_background_task(
                task_id, status="failed", message="后台索引失败",
                error=str(error)[:1000],
            )
        finally:
            with self._lock:
                self._futures.pop(task_id, None)
