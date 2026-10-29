from __future__ import annotations

import json
import re
from typing import Any

from .rag import normalize_text, query_terms


PDF_CITATION = re.compile(r"\[\s*PDF\s*第\s*(\d+)\s*页\s*\]", re.IGNORECASE)
BOOK_CITATION = re.compile(r"\[\s*([^\[\]｜|]{1,160})\s*[｜|]\s*PDF\s*第\s*(\d+)\s*页\s*\]", re.IGNORECASE)
NETWORK_CITATION = re.compile(r"\[\s*网络\s*\d+\s*\]")
MARKDOWN_PREFIX = re.compile(r"^\s*(?:#{1,6}|[-*+]\s+|\d+[.)]\s+)")
CLAIM_SPLIT = re.compile(r"(?<=[。！？；])(?!\s*\[[^\]]*PDF)\s*", re.IGNORECASE)


def extract_claims(answer: str, *, limit: int = 24) -> list[dict]:
    claims: list[dict] = []
    for raw_line in answer.splitlines():
        line = MARKDOWN_PREFIX.sub("", raw_line).strip()
        if not line or "http://" in line or "https://" in line:
            continue
        for part in CLAIM_SPLIT.split(line):
            claim = part.strip()
            citations = [{"document_title": title.strip(), "page_number": int(page)} for title, page in BOOK_CITATION.findall(claim)]
            plain = PDF_CITATION.sub("", BOOK_CITATION.sub("", claim)).strip()
            if len(re.sub(r"\s+", "", plain)) < 8:
                continue
            pages = list(dict.fromkeys([item["page_number"] for item in citations] + [int(value) for value in PDF_CITATION.findall(claim)]))
            if not pages and NETWORK_CITATION.search(claim):
                continue
            claims.append({"claim": plain, "pages": pages, "citations": citations})
            if len(claims) >= limit:
                return claims
    return claims


def _support_score(claim: str, evidence: str) -> float:
    terms = query_terms(claim, limit=48)
    if not terms:
        return 0.0
    normalized = normalize_text(evidence).casefold()
    matched = [term for term in terms if term in normalized]
    weighted_total = sum(max(2, len(term)) for term in terms)
    weighted_match = sum(max(2, len(term)) for term in matched)
    return weighted_match / max(1, weighted_total)


def local_verification(answer: str, sources: list[dict]) -> dict:
    source_pages: dict[int, list[str]] = {}
    for source in sources:
        source_pages.setdefault(int(source["page_number"]), []).append(str(source["content"]))

    checks = []
    for index, item in enumerate(extract_claims(answer), 1):
        pages = item["pages"]
        citations = item.get("citations", [])
        if citations:
            matched_sources = [source for citation in citations for source in sources if int(source["page_number"]) == citation["page_number"] and str(source.get("document_title", "")).strip() == citation["document_title"]]
            missing_citations = [citation for citation in citations if not any(int(source["page_number"]) == citation["page_number"] and str(source.get("document_title", "")).strip() == citation["document_title"] for source in sources)]
            evidence = "\n".join(str(source["content"]) for source in matched_sources)
            origins = [{"document_id": source.get("document_id"), "document_title": source.get("document_title", "当前教材"), "page_number": int(source["page_number"])} for source in matched_sources]
        else:
            missing_citations = [{"page_number": page} for page in pages if page not in source_pages]
            evidence = "\n".join(content for page in pages for content in source_pages.get(page, []))
            origins = [{"document_id": source.get("document_id"), "document_title": source.get("document_title", "当前教材"), "page_number": int(source["page_number"])} for source in sources if int(source["page_number"]) in pages]
        score = _support_score(item["claim"], evidence)
        if not pages:
            status, reason = "missing", "这条结论没有标注 PDF 页码。"
        elif missing_citations:
            missing_label = "、".join(f"{item.get('document_title', 'PDF')} 第{item['page_number']}页" for item in missing_citations)
            status, reason = "unsupported", f"引用出处未出现在本次检索证据中：{missing_label}。"
        elif score >= 0.42:
            status, reason = "supported", "引用页原文与结论中的关键概念高度一致。"
        elif score >= 0.18:
            status, reason = "partial", "引用页包含部分关键概念，仍需人工确认完整推论。"
        else:
            status, reason = "unsupported", "引用页与该结论的可核对文字重合较少。"
        snippet = normalize_text(evidence)[:220]
        checks.append({
            "index": index,
            "claim": item["claim"],
            "pages": pages,
            "origins": list({(item.get("document_id"), item["document_title"], item["page_number"]): item for item in origins}.values()),
            "status": status,
            "reason": reason,
            "score": round(score, 3),
            "evidence": f"{snippet}{'…' if len(normalize_text(evidence)) > 220 else ''}",
        })
    return summarize(checks, method="local")


def summarize(checks: list[dict], *, method: str, warning: str = "") -> dict:
    counts = {status: sum(item["status"] == status for item in checks) for status in (
        "supported", "partial", "unsupported", "missing"
    )}
    return {"method": method, "counts": counts, "checks": checks, "warning": warning}


def _json_object(value: str) -> dict:
    clean = value.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
    start, end = clean.find("{"), clean.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("核验模型没有返回 JSON。")
    payload = json.loads(clean[start:end + 1])
    if not isinstance(payload, dict):
        raise ValueError("核验模型返回格式无效。")
    return payload


def merge_ai_checks(baseline: dict, payload: dict) -> dict:
    by_index = {
        int(item.get("index")): item for item in payload.get("checks", [])
        if isinstance(item, dict) and str(item.get("index", "")).isdigit()
    }
    allowed = {"supported", "partial", "unsupported", "missing"}
    for check in baseline["checks"]:
        ai_check = by_index.get(check["index"])
        if not ai_check:
            continue
        status = str(ai_check.get("status", ""))
        if status not in allowed:
            continue
        # A model cannot validate a page that was never retrieved, or invent a citation.
        if check["status"] in {"missing", "unsupported"} and (
            not check["pages"] or "未出现在本次检索证据" in check["reason"]
        ):
            continue
        check["status"] = status
        check["reason"] = str(ai_check.get("reason") or check["reason"])[:240]
    return summarize(baseline["checks"], method="ai")


async def verify_citations(
    answer: str,
    sources: list[dict],
    provider: Any,
    profile: Any,
    api_key: str,
) -> dict:
    baseline = local_verification(answer, sources)
    if not baseline["checks"]:
        baseline["warning"] = "回答中没有可核验的完整陈述。"
        return baseline

    evidence = "\n\n".join(
        f"{source.get('document_title', '当前教材')}｜PDF第{source['page_number']}页：{source['content']}" for source in sources
    )
    claim_list = "\n".join(
        f"{item['index']}. {item['claim']}｜引用页：{item['pages'] or '无'}"
        for item in baseline["checks"]
    )
    prompt = f"""请逐条核验下面的回答结论是否被指定 PDF 页原文支持。
只能使用给出的证据，不得使用常识补足。supported=原文直接支持；partial=仅部分支持或存在推断；unsupported=原文不支持/页码错误；missing=没有页码。
只返回 JSON：{{"checks":[{{"index":1,"status":"supported|partial|unsupported|missing","reason":"简短理由"}}]}}

【待核验结论】
{claim_list}

【PDF 原文证据】
{evidence}
"""
    try:
        raw = await provider.complete(
            profile,
            api_key,
            system="你是教材引用审计员。严格逐条核验证据，输出合法 JSON，不得添加证据中没有的信息。",
            prompt=prompt,
        )
        payload = _json_object(raw)
        return merge_ai_checks(baseline, payload)
    except Exception as error:
        return summarize(
            baseline["checks"], method="local",
            warning=f"AI 核验暂不可用，已使用本地证据核验：{str(error)[:160]}",
        )
