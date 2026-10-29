from .chapters import chapter_key
"""Durable chapter generation, independent of browser connections."""
import asyncio
import math
import time
import httpx
import hashlib
import json
import re
from dataclasses import asdict

from pypdf import PdfReader

from .providers import IncompleteModelResponse, ModelRateLimitError, ModelContentFilterError


class SummaryStopped(Exception):
    pass


def split_source(text, limit=7000):
    parts = []
    page = ""
    for section in re.split(r"(?=【PDF \d+】)", text):
        label = re.match(r"【PDF \d+】", section)
        if label:
            page = label[0]
            section = section[len(page):]
        size = max(1, limit - len(page) - 1)
        for offset in range(0, len(section), size):
            fragment = page + section[offset:offset + size]
            if parts and len(parts[-1]) + len(fragment) + 1 <= limit:
                parts[-1] += "\n" + fragment
            else:
                parts.append(fragment)
    return parts


class SummaryPacer:
    """Shared by all summary jobs in the worker; cooldown survives task retries."""
    def __init__(self, clock=None, sleep=None):
        self.clock = clock or time.monotonic
        self.sleep = sleep or asyncio.sleep
        self.next_allowed = 0.0
        self.interval = 3

    def defer(self, seconds):
        self.interval = max(self.interval, 10)
        self.next_allowed = max(self.next_allowed, self.clock() + seconds)

    async def wait(self, check, progress):
        remaining = self.next_allowed - self.clock()
        if remaining > 120:
            raise RuntimeError(f"模型仍处于服务商冷却期，请至少等待{math.ceil(remaining)}秒后重新执行。")
        last_second = None
        while self.clock() < self.next_allowed:
            check()
            remaining = math.ceil(self.next_allowed - self.clock())
            if remaining != last_second:
                progress(f"请求节流/限流冷却等待：{remaining}秒，已完成分块保留。")
                last_second = remaining
            await self.sleep(min(0.25, self.next_allowed - self.clock()))
        check()
        self.next_allowed = self.clock() + self.interval


async def stream_block(provider, profile, api_key, source, prompt, check, progress, pacer=None):
    """Retry transient transport failures; never concatenate partial attempts."""
    for attempt in range(3):
        check()
        if pacer:
            await pacer.wait(check, progress)
            progress("正在请求模型生成当前分块…")
        text = ""
        try:
            async for delta in provider.stream(profile, api_key, excerpt=source, question=prompt,
                                               history=[], max_tokens=profile.max_tokens):
                check()
                text += delta
            return text
        except ModelRateLimitError as error:
            check()
            seconds = max(30 * 2 ** attempt, error.retry_after)
            if pacer:
                pacer.defer(seconds)
            if attempt == 2 or seconds > 120:
                raise RuntimeError(f"模型触发请求突增或速率限制，已停止自动重试。请至少等待{math.ceil(seconds)}秒后在任务中心重新执行；已完成分块保留。") from error
            progress(f"模型触发请求突增/限流保护，等待{math.ceil(seconds)}秒后重试（{attempt + 1}/2）。")
            for _ in range(math.ceil(seconds * 4)):
                check()
                await asyncio.sleep(0.25)
        except (httpx.TransportError, httpx.HTTPStatusError, IncompleteModelResponse) as error:
            if isinstance(error, IncompleteModelResponse) and not error.retryable:
                raise
            if isinstance(error, httpx.HTTPStatusError) and error.response.status_code not in {502, 503, 504}:
                raise
            check()
            if attempt == 2:
                detail = f" 末次原因：{error}" if isinstance(error, IncompleteModelResponse) else ""
                raise RuntimeError("模型连接连续中断或暂时不可用，自动重试2次后仍未完成。已完成分块已保留，请在任务中心重新执行；也可检查网络、代理和模型服务状态。" + detail) from error
            progress(f"模型连接中断或服务暂未完成响应，正在重试当前分块（{attempt + 1}/2）；已完成分块保留。")
            # Check pause/cancellation during the bounded backoff, too.
            for _ in range(4 * (attempt + 1)):
                check()
                await asyncio.sleep(0.25)


async def run_summary(repository, task_id, options, provider, credential_store, pacer=None):
    task = repository.background_task(task_id)
    document_id = task["document_id"]
    profile = repository.profile(options["profile_id"])
    api_key = credential_store.get(profile.id)
    if not api_key:
        raise ValueError("该模型没有已保存的 API Key，请在模型配置中保存后重试。")

    def check():
        current = repository.background_task(task_id)
        if current["cancel_requested"] or current["status"] == "paused":
            raise SummaryStopped()

    def progress(message, **values):
        check()
        repository.update_background_task(task_id, message=message, **values)

    rules = "只依据输入的教材或分块总结，用中文生成便于复习的知识结构。用【标题】、短段落和要点组织，保留PDF页码，说明概念关系、学习重点、易混点和复习路线。不编造缺失原文。章节结构依次为【本节结论】【知识骨架】【核心概念与关系】【学习重点】【易混点】【复习路线】，大章或全书需说明各部分之间的承接和联系；禁止Markdown标题符号、表格和代码块。"
    async def block(source, prompt, depth=0):
        check()
        identity = json.dumps(["server-summary-v1", asdict(profile), source, prompt], ensure_ascii=False, sort_keys=True)
        key = hashlib.sha256(identity.encode()).hexdigest()
        cached = repository.summary_checkpoint(document_id, key)
        if cached:
            return cached
        text = ""
        stage = repository.background_task(task_id)["message"]
        def report(message):
            progress(f"{stage} · {message}")
        try:
            text = await stream_block(provider, profile, api_key, source, prompt, check, report, pacer)
        except RuntimeError as error:
            if not any(term in str(error) for term in ("输出额度", "max_output_tokens")):
                raise
            if depth >= 3 or len(source) < 1000:
                raise RuntimeError("缩块后仍耗尽输出额度；已完成分块已保存，请提高最大输出 Token 后重新执行。") from error
            report("输出额度耗尽，自动缩小分块重试…")
            fragments = []
            for part in split_source(source, (len(source) + 1) // 2):
                fragments.append(await block(part, prompt + " 本次仅处理此块，简洁输出关键结论。", depth + 1))
            text = "\n\n".join(fragments)
        if not text.strip():
            raise RuntimeError("模型未返回总结正文。")
        if len(text) > 50000:
            raise RuntimeError("总结超过保存上限，已完成分块已保留。")
        repository.save_summary_checkpoint(document_id, key, text)
        check()
        return text

    async def summarize(source, title):
        parts = split_source(source)
        if not parts:
            raise ValueError(f"《{title}》没有可总结的文字，请进入阅读器执行 OCR 后重试。")
        results = []
        for index, part in enumerate(parts):
            progress(f"{title} · 分块 {index + 1}/{len(parts)}")
            results.append(await block(part, rules + f" 当前章节：{title}。仅总结本块，控制在800字以内。"))
        for level in range(4):
            if len(results) == 1:
                return results[0]
            groups = split_source("\n\n".join(results), 10000)
            results = []
            for index, group in enumerate(groups):
                progress(f"{title} · 第{level + 1}层汇总 {index + 1}/{len(groups)}")
                results.append(await block(group, rules + f" 合并《{title}》各块，去重并覆盖所有知识点，控制在1500字以内。"))
        if len(results) == 1:
            return results[0]
        raise RuntimeError("汇总未收敛，已完成分块已保存，请调整模型后重新执行。")

    check()
    progress("读取教材与已保存的章节…")
    reader = PdfReader(str(repository.document_path(document_id)))
    pages = len(reader.pages)
    outline = options["outline"]
    if any(node["page"] > pages for node in outline):
        raise ValueError("目录页码超出 PDF 总页数，请修正目录后重试。")
    cached_pages = {item["page_number"]: item["text"] for item in repository.list_ocr_pages(document_id)}
    repository.reconcile_chapter_keys(document_id, outline)
    saved = {item["chapter_key"]: item for item in repository.list_chapter_summaries(document_id)}
    gaps = {item["chapter_key"]: item for item in repository.list_summary_gaps(document_id)}
    marker = "【总结不完整：存在待补充章节】"
    finished = 0
    any_usable = False
    target = options["chapter_index"]

    def boundary_of(index):
        return next((j for j in range(index + 1, len(outline)) if outline[j]["depth"] <= outline[index]["depth"]), len(outline))

    def gaps_in(start, boundary, include_book=False):
        keys = {chapter_key(document_id, outline, j) for j in range(start, boundary)}
        if include_book:
            keys.add(f"{document_id}:__book__")
        return [gap for key, gap in gaps.items() if key in keys]

    def scoped_gaps():
        return gaps_in(target or 0, boundary_of(target) if target is not None else len(outline), target is None)

    def publish_gaps():
        result = repository.background_task(task_id)["result"]
        repository.update_background_task(task_id, result={**result, "missing_chapters": scoped_gaps()})

    def mark_gap(key, title, start, end, error):
        check()
        gaps[key] = repository.save_summary_gap(document_id, key, title, start, end, str(error)[:300])
        publish_gaps()
        progress(f"待补充：{title}；继续处理其他章节。")

    def notice(missing):
        lines = [f"本次未覆盖以下{len(missing)}处内容，不得据此视为完整教材总结；可人工总结后导入补齐："]
        lines += [f"{item['title'][:80]}〔PDF {item['start_page']}-{item['end_page']}〕：待补充" for item in missing[:100]]
        if len(missing) > 100:
            lines.append(f"其余{len(missing) - 100}处请在任务中心查看完整列表。")
        return "\n".join(lines)

    def store(key, title, start, end, depth, body, missing):
        nonlocal any_usable
        check()
        content = f"{marker}\n\n{body}\n\n【待补充清单】\n{notice(missing)}" if missing else body
        if len(content) > 50000:
            raise RuntimeError("总结超过保存上限，已完成分块已保留。")
        result = repository.save_chapter_summary(document_id, key, title, start, end, depth, content)
        gaps.pop(key, None)
        saved[key] = result
        any_usable = any_usable or bool(body.strip())
        return {**result, "_model_content": body}

    def filtered(error):
        return isinstance(error, ModelContentFilterError) or isinstance(error, IncompleteModelResponse) and error.reason in {"content_filter", "safety", "sensitive_content"}

    total = (boundary_of(target) - target) if target is not None else len(outline) + 1
    repository.update_background_task(task_id, total=total, progress=0)

    async def chapter(index):
        nonlocal finished, any_usable
        check()
        node = outline[index]
        key = chapter_key(document_id, outline, index)
        boundary = boundary_of(index)
        end = min(pages, max(node["page"], outline[boundary]["page"] - 1)) if boundary < len(outline) else pages
        descendants = list(range(index + 1, boundary))
        child_depth = min((outline[j]["depth"] for j in descendants), default=-1)
        children = [j for j in descendants if outline[j]["depth"] == child_depth]
        if key in saved and index != target and not saved[key]["content"].startswith(marker) and not gaps_in(index, boundary):
            finished += boundary - index
            any_usable = True
            progress(f"复用章节：{node['title']}", progress=finished)
            return saved[key]
        if children:
            sources = []
            for child_index in children:
                child = await chapter(child_index)
                if child and child.get("_model_content", child["content"]).strip():
                    sources.append(f"【{child['title']}｜PDF {child['start_page']}-{child['end_page']}】\n{child.get('_model_content', child['content'])}")
            source = "\n\n".join(sources)
        else:
            sources = []
            for number in range(node["page"], end + 1):
                check()
                text = cached_pages.get(number) or (reader.pages[number - 1].extract_text() or "")
                if text.strip():
                    sources.append(f"【PDF {number}】{text}")
            source = "\n".join(sources)
        try:
            content = await summarize(source, node["title"]) if source or not children else ""
            # A successful attempt resolves an earlier direct block at this node.
            gaps.pop(key, None)
            missing = gaps_in(index, boundary)
            result = store(key, node["title"], node["page"], end, node["depth"], content, missing)
            progress(f"已保存：{node['title']}" + ("（部分总结，存在待补充章节）" if missing else ""))
        except (ModelContentFilterError, IncompleteModelResponse) as error:
            if not filtered(error):
                raise
            mark_gap(key, node["title"], node["page"], end, error)
            result = None
        finished += 1
        progress(repository.background_task(task_id)["message"], progress=finished)
        return result

    if target is not None:
        await chapter(target)
    else:
        roots = [j for j, node in enumerate(outline) if node["depth"] == min(item["depth"] for item in outline)]
        sources = []
        for index in roots:
            result = await chapter(index)
            if result and result.get("_model_content", result["content"]).strip():
                sources.append(f"【{result['title']}｜PDF {result['start_page']}-{result['end_page']}】\n{result.get('_model_content', result['content'])}")
        key = f"{document_id}:__book__"
        try:
            content = await summarize("\n\n".join(sources), "全书知识结构") if sources else ""
            gaps.pop(key, None)
            store(key, "全书知识结构", outline[0]["page"], pages, 0, content, scoped_gaps())
        except (ModelContentFilterError, IncompleteModelResponse) as error:
            if not filtered(error):
                raise
            mark_gap(key, "全书知识结构", outline[0]["page"], pages, error)
    check()
    publish_gaps()
    missing = scoped_gaps()
    message = (f"部分完成：{len(missing)}处待补充；" + ("可用总结已保存，尚未覆盖全部教材。" if any_usable else "暂无可用的自动总结，请人工补充。")) if missing else "总结已完成并保存，可返回教材总览查看。"
    repository.update_background_task(task_id, status="partial" if missing else "completed", progress=total, message=message)
