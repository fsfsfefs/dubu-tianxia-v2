from __future__ import annotations

from html.parser import HTMLParser
from urllib.parse import parse_qs, unquote, urlparse

import httpx


class _DuckDuckGoParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.results: list[dict[str, str]] = []
        self._field = ""
        self._buffer: list[str] = []
        self._href = ""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if tag == "a" and "result__a" in classes:
            self._field = "title"
            self._buffer = []
            self._href = values.get("href") or ""
        elif "result__snippet" in classes:
            self._field = "snippet"
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._field:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._field == "title" and tag == "a":
            title = " ".join("".join(self._buffer).split())
            if title:
                self.results.append({"title": title, "url": _actual_url(self._href), "snippet": ""})
            self._field = ""
        elif self._field == "snippet" and tag in {"a", "div"}:
            snippet = " ".join("".join(self._buffer).split())
            if self.results and snippet:
                self.results[-1]["snippet"] = snippet
            self._field = ""


def _actual_url(value: str) -> str:
    parsed = urlparse(value)
    redirected = parse_qs(parsed.query).get("uddg", [""])[0]
    result = unquote(redirected or value)
    return result if result.startswith(("https://", "http://")) else ""


def parse_search_results(html: str, limit: int = 5) -> list[dict[str, str]]:
    parser = _DuckDuckGoParser()
    parser.feed(html)
    return [item for item in parser.results if item["url"]][:limit]


async def search_professional_web_results(query: str, limit: int = 5) -> list[dict[str, str]]:
    if not query.strip():
        return ""
    try:
        async with httpx.AsyncClient(timeout=12, follow_redirects=True) as client:
            response = await client.get(
                "https://html.duckduckgo.com/html/",
                params={"q": f"{query.strip()} 专业资料"},
                headers={"User-Agent": "Mozilla/5.0 GuidedReader/1.0"},
            )
            response.raise_for_status()
        results = parse_search_results(response.text, limit)
    except (httpx.HTTPError, ValueError):
        return []
    return results


def format_web_context(results: list[dict[str, str]]) -> str:
    return "\n\n".join(
        f"[网络{index}] {item['title']}\nURL: {item['url']}\n摘要: {item['snippet'] or '搜索结果未提供摘要'}"
        for index, item in enumerate(results, 1)
    )


async def search_professional_web(query: str, limit: int = 5) -> str:
    return format_web_context(await search_professional_web_results(query, limit))
