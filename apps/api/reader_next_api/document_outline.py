"""Shared original/saved outline resolution and bounded, page-labelled AI evidence."""
import hashlib
import json
from pypdf import PdfReader
from .compatibility import _pdf_outline


def validate_outline(items, page_count):
    if not isinstance(items, list) or not 1 <= len(items) <= 1000:
        raise ValueError("目录需包含1—1000项。")
    result = []
    for item in items:
        if not isinstance(item, dict):
            raise ValueError("目录格式不正确。")
        title, page, depth = item.get("title"), item.get("page"), item.get("depth", 0)
        if not isinstance(title, str) or not title.strip() or len(title.strip()) > 500:
            raise ValueError("章节标题不能为空且不能超过500字。")
        if type(page) is not int or not 1 <= page <= page_count:
            raise ValueError(f"章节页码必须在1—{page_count}之间，使用PDF实际页码。")
        if type(depth) is not int or not 0 <= depth <= 20:
            raise ValueError("章节层级需在0—20之间。")
        if (not result and depth != 0) or (result and depth > result[-1]["depth"] + 1):
            raise ValueError("首项层级必须为0，后续层级不能跳级。")
        if result and page < result[-1]["page"]:
            raise ValueError("目录页码必须按阅读顺序排列，可用上移/下移校对。")
        result.append({"title": title.strip(), "page": page, "depth": depth})
    return result


def resolve_outline(repository, document_id):
    path = repository.document_path(document_id)
    with path.open("rb") as stream:
        page_count = len(PdfReader(stream).pages)
    saved = repository.get_imported_outline(document_id)
    items = [{k: item[k] for k in ("title", "page", "depth")} for item in saved] if saved else _pdf_outline(path)
    source = saved[0].get("source", "import") if saved else ("pdf" if items else "none")
    revision = hashlib.sha256(json.dumps(items, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    return {"outline": items, "source": source, "page_count": page_count, "revision": revision}


def outline_evidence(repository, document_id):
    path = repository.document_path(document_id)
    cached = {item["page_number"]: item["text"] for item in repository.list_ocr_pages(document_id)}
    parts, readable = [], 0
    with path.open("rb") as stream:
        reader = PdfReader(stream)
        count = len(reader.pages)
        if count > 3000:
            raise ValueError("超过3000页的教材请导入或人工编写目录。")
        quota = max(16, 50000 // max(count, 1))
        for number, page in enumerate(reader.pages, 1):
            text = (cached.get(number) or page.extract_text() or "").strip()
            if text:
                readable += 1
                # Front matter preserves printed TOC; every later page contributes its heading.
                limit = min(1800, max(quota, 1000)) if number <= 20 else quota
                parts.append(f"【PDF实际第{number}页】\n{text[:limit]}")
    if not readable:
        raise ValueError("尚未识别到文字，请先准备原文/OCR或人工添加目录。")
    return "\n".join(parts), count, count - readable


def parse_outline(raw, page_count):
    start, end = raw.find("["), raw.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("模型没有返回目录数组，请重新生成或人工编辑。")
    try:
        parsed = json.loads(raw[start:end + 1])
    except json.JSONDecodeError as error:
        raise ValueError("模型返回的目录JSON不完整，请重新生成或人工编辑。") from error
    return validate_outline(parsed, page_count)
