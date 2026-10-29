from __future__ import annotations

import math
import json
import re
from collections.abc import AsyncIterator
from email.utils import parsedate_to_datetime
from datetime import datetime, timezone
from urllib.parse import urlsplit

import httpx

from .domain import ModelProfile


ANSWER_PRESENTATION = """回答必须便于阅读和复习：
先用“## 核心结论”给出一段直接答案，再按需要使用“## 关键依据”“## 详细解释”“## 例子”“## 需要注意”等短标题。
每个部分只保留有信息量的内容；并列内容使用简短列表，每条只表达一个观点，重要概念用 **加粗** 标记。
同一个概念的名称、定义、特征、补充说明和例子必须放在同一小节中，不要拆成连续多条；不要使用 1、2、3 这类数字序号。
不要输出 Markdown 表格、代码块、装饰性分隔线，不要重复问题，也不要堆砌大段原文。"""

SYSTEM_PROMPT = f"""你是一个严谨的教材学习助手。只根据用户给出的教材摘录和问题回答。
清楚区分教材原文、解释和推断；信息不足时直接说明。使用简洁中文。
当提供来源页码时，在引用或解释该摘录的句子后标注页码，例如 [第12页]。
{ANSWER_PRESENTATION}"""

WEB_SYSTEM_PROMPT = f"""你是一个严谨的专业学习助手。综合用户提供的全书知识上下文、联网检索资料和通用专业知识回答。
明确区分“教材内容”和“外部专业资料”；不得把搜索摘要伪装成教材原文。
引用联网资料时使用 [网络1] 这样的编号，并在回答末尾列出对应标题和 URL。
若联网结果为空或不足，应明确说明，不得虚构来源。使用清晰、结构化的中文。
{ANSWER_PRESENTATION}"""

RAG_SYSTEM_PROMPT = f"""你是一个严谨的多教材全文问答助手。优先依据检索到的教材原文回答，并主动比较各书观点的一致、互补与分歧。
每项教材事实都必须在对应句末标注 [书名｜PDF第X页]；书名和页码只能来自上下文。
如果多个片段共同支持结论，应同时标注多个“书名＋页码”出处。检索证据不足时必须直接说明，不得编造教材内容。
联网资料只能用于补充解释，必须与教材结论明确区分，并使用 [网络1] 形式标注。使用清晰、结构化的中文。
{ANSWER_PRESENTATION}"""


def uses_responses_api(profile: ModelProfile) -> bool:
    return urlsplit(profile.endpoint).path.rstrip("/").endswith("/responses")


def response_error_detail(response: httpx.Response) -> str:
    try:
        payload = response.json()
        error = payload.get("error", payload)
        if isinstance(error, dict):
            message = error.get("message") or error.get("code")
        else:
            message = str(error)
        return str(message or "").strip()[:240]
    except (ValueError, TypeError, AttributeError):
        return response.text.strip()[:240]


def extract_response_text(payload: dict) -> str:
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    parts: list[str] = []
    for item in payload.get("output", []):
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for content in item.get("content", []):
            if isinstance(content, dict) and content.get("type") == "output_text" and content.get("text"):
                parts.append(str(content["text"]))
    return "".join(parts)


def build_request_body(
    profile: ModelProfile,
    messages: list[dict[str, str]],
    *,
    stream: bool,
    max_tokens: int | None = None,
    temperature: float | None = None,
) -> dict:
    common = {
        "model": profile.model,
        "temperature": profile.temperature if temperature is None else temperature,
        "stream": stream,
    }
    output_limit = max_tokens or profile.max_tokens
    if uses_responses_api(profile):
        return {**common, "input": messages, "max_output_tokens": output_limit}
    return {**common, "messages": messages, "max_tokens": output_limit}


class ModelContentFilterError(RuntimeError):
    def __init__(self):
        super().__init__("模型服务因内容审核拒绝了本次输入或输出，请查看服务商控制台详情。")


def content_filter_error(payload):
    if not isinstance(payload, dict):
        return None
    error = payload.get("error") or payload
    if not isinstance(error, dict):
        return None
    code = str(error.get("code") or "").lower()
    message = str(error.get("message") or "").lower()
    if re.search(r"unavailable|timeout|internal.?error|server.?error", code + " " + message):
        return None
    if any(term in code for term in ("sensitivecontent", "contentfilter", "content_filter", "datainspectionfailed", "inputtextrisk", "outputtextrisk")) or any(term in message for term in ("input text may contain sensitive information", "output text may contain sensitive information", "content filter", "content policy violation")):
        return ModelContentFilterError()
    return None


class ModelRateLimitError(RuntimeError):
    def __init__(self, retry_after: float = 0, burst: bool = True):
        self.retry_after = retry_after if math.isfinite(retry_after) and retry_after > 0 else 0
        super().__init__("模型服务触发请求突增保护，请放慢请求并等待恢复。" if burst else "模型请求超过服务商速率限制，请等待后重试。")


def rate_limit_error(payload, retry_after=None):
    if not isinstance(payload, dict):
        return None
    error = payload.get("error") or payload
    if not isinstance(error, dict):
        error = {"message": str(error)}
    message = str(error.get("message") or "")
    code = str(error.get("code") or "")
    combined = (code + " " + message).lower()
    if re.search(r"insufficient_quota|quotaexceeded|billing|balance|credit|余额|欠费|额度不足", combined):
        return None
    burst = any(term in combined for term in ("requestbursttoofast", "serveroverloaded", "request burst", "traffic growth"))
    if not burst and not re.search(r"rate.?limit|too.?many.?requests|限流|请求过于频繁", combined):
        return None
    seconds = 0
    if retry_after:
        try:
            seconds = float(retry_after)
        except (TypeError, ValueError):
            try:
                seconds = (parsedate_to_datetime(str(retry_after)) - datetime.now(timezone.utc)).total_seconds()
            except (TypeError, ValueError, OverflowError):
                pass
    return ModelRateLimitError(seconds, burst)


def raise_service_error(payload):
    filtered = content_filter_error(payload)
    if filtered:
        raise filtered
    limited = rate_limit_error(payload)
    if limited:
        raise limited
    error = payload.get("error") or payload
    raise RuntimeError(str((error.get("message") or error.get("code") or "模型服务返回错误") if isinstance(error, dict) else error))


def check_http_response(response):
    if response.status_code >= 400:
        try:
            payload = response.json()
            if response.status_code in {400, 403}:
                filtered = content_filter_error(payload)
                if filtered:
                    raise filtered
            limited = rate_limit_error(payload, response.headers.get("retry-after"))
        except ValueError:
            limited = None
        if limited:
            raise limited
    response.raise_for_status()


class IncompleteModelResponse(RuntimeError):
    def __init__(self, response: dict):
        details = response.get("incomplete_details") or {}
        details = details if isinstance(details, dict) else {}
        reason = details.get("reason") or ("content_filter" if details.get("content_filter") else "unknown")
        self.reason = reason if isinstance(reason, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", reason) else "unknown"
        self.retryable = self.reason in {"server_error", "timeout", "overloaded", "service_unavailable"}
        if self.reason in {"max_output_tokens", "max_tokens", "length"}:
            message = "模型输出额度已耗尽（可能包含推理内容），请提高最大输出 Token 后重试。"
        elif self.reason in {"content_filter", "safety", "sensitive_content"}:
            message = "模型服务的内容审核终止了本次响应。请在服务商控制台查看审核详情并按其要求处理；重复执行同一分块可能仍会失败。"
        elif self.reason == "context_length_exceeded":
            message = "模型输入超出上下文限制，请缩小章节范围后重试。"
        elif self.retryable:
            message = "模型服务暂时无法完成响应，可稍后重试。"
        else:
            message = "模型主动结束响应但未完成生成，需依据原因码检查服务商控制台。"
        message += f"（原因：{self.reason}）"
        response_id = response.get("id")
        if isinstance(response_id, str) and re.fullmatch(r"[a-zA-Z0-9_.:-]{1,128}", response_id):
            message += f" 响应编号：{response_id}"
        super().__init__(message)


def extract_stream_delta(event: dict, responses_api: bool) -> str | None:
    if event.get("error"):
        raise_service_error(event)
    if responses_api:
        if event.get("type") == "error":
            raise_service_error(event)
        if event.get("type") == "response.failed":
            failure = event.get("response", {}).get("error") or {"message": "模型响应失败"}
            raise_service_error(failure)
        response = event.get("response") or {}
        if event.get("type") == "response.incomplete" or (
            event.get("type") == "response.completed" and response.get("status") == "incomplete"
        ):
            raise IncompleteModelResponse(response)
        return event.get("delta") if event.get("type") == "response.output_text.delta" else None
    choice = event["choices"][0]
    if choice.get("finish_reason") == "length":
        raise RuntimeError("模型输出额度已耗尽，回答尚未完成，请提高最大输出 Token 后重试。")
    return choice["delta"].get("content")


def provider_error_message(error: Exception) -> str:
    if isinstance(error, (httpx.RemoteProtocolError, httpx.ReadError)):
        return "模型服务或代理提前关闭了连接，回答尚未完整接收。已保存内容保留，请重新执行失败任务。"
    if isinstance(error, httpx.ConnectError):
        return "无法连接模型服务。请检查网络、代理、防火墙和 Endpoint 地址。"
    if isinstance(error, httpx.TimeoutException):
        return "模型服务响应超时，请稍后重试或检查网络连接。"
    if isinstance(error, httpx.HTTPStatusError):
        status = error.response.status_code
        if status == 401:
            return "API Key 无效或已过期，请在模型设置中重新填写。"
        if status == 403:
            return "模型服务拒绝访问，请检查 API Key 权限和账户状态。"
        if status == 404:
            return "模型接口或模型名称不存在，请检查 Endpoint 和模型 ID。"
        if status == 429:
            return "模型服务请求过于频繁或额度不足，请稍后重试并检查账户余额。"
        if status >= 500:
            return f"模型服务暂时不可用（HTTP {status}），请稍后重试。"
        detail = response_error_detail(error.response)
        return f"模型服务请求失败（HTTP {status}）{f'：{detail}' if detail else '。'}"
    return str(error)[:300] or "模型请求失败。"


class OpenAICompatibleProvider:
    def __init__(self, client: httpx.AsyncClient | None = None):
        self.client = client

    async def stream(
        self,
        profile: ModelProfile,
        api_key: str,
        *,
        excerpt: str,
        question: str,
        history: list[dict[str, str]],
        page_number: int | None = None,
        max_tokens: int | None = None,
        use_web: bool = False,
        web_context: str = "",
        rag_context: str = "",
    ) -> AsyncIterator[str]:
        system_prompt = RAG_SYSTEM_PROMPT if rag_context else WEB_SYSTEM_PROMPT if use_web else SYSTEM_PROMPT
        messages = [{"role": "system", "content": system_prompt}]
        messages.extend(history[-12:])
        context_title = "全文检索到的教材原文" if rag_context else "全书知识上下文" if use_web else "教材摘录"
        context = rag_context or excerpt
        messages.append(
            {
                "role": "user",
                "content": f"【来源范围】\n{f'PDF 第 {page_number} 页' if page_number else '整本 PDF'}\n\n【{context_title}】\n{context or '没有可用的教材原文'}\n\n【全书知识结构（仅作辅助）】\n{excerpt or '未提供'}\n\n【联网检索资料】\n{web_context or ('联网检索暂未获得可用结果' if use_web else '未启用')}\n\n【问题】\n{question}",
            }
        )
        responses_api = uses_responses_api(profile)
        body = build_request_body(profile, messages, stream=True, max_tokens=max_tokens)
        owned = self.client is None
        client = self.client or httpx.AsyncClient(timeout=120)
        received_text = ""
        stream_completed = False
        try:
            async with client.stream(
                "POST",
                profile.endpoint,
                headers={"Authorization": f"Bearer {api_key}"},
                json=body,
            ) as response:
                if response.status_code >= 400:
                    await response.aread()
                check_http_response(response)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        stream_completed = True
                        break
                    try:
                        event = json.loads(payload)
                        delta = extract_stream_delta(event, responses_api)
                    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
                        continue
                    if responses_api and event.get("type") == "response.completed":
                        stream_completed = True
                    elif not responses_api and any(item.get("finish_reason") for item in event.get("choices", []) if isinstance(item, dict)):
                        stream_completed = True
                    if delta:
                        received_text += str(delta)
                        yield str(delta)
                    elif responses_api and event.get("type") == "response.completed":
                        # Some compatible services send only the final response snapshot.
                        final_text = extract_response_text(event.get("response", {}))
                        if final_text.startswith(received_text):
                            remainder = final_text[len(received_text):]
                            if remainder:
                                received_text += remainder
                                yield remainder
                    if stream_completed:
                        break
            if received_text.strip() and not stream_completed:
                raise httpx.RemoteProtocolError("模型流提前结束，未收到完成标记。")
            if not received_text.strip():
                raise RuntimeError("模型请求结束但未返回可读取的正文。请检查模型的输出额度、内容限制及流式接口兼容性。")
        finally:
            if owned:
                await client.aclose()

    async def complete(
        self, profile: ModelProfile, api_key: str, *, system: str, prompt: str
    ) -> str:
        responses_api = uses_responses_api(profile)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": prompt}]
        body = build_request_body(
            profile,
            messages,
            stream=False,
            temperature=min(profile.temperature, 0.4),
        )
        owned = self.client is None
        client = self.client or httpx.AsyncClient(timeout=120)
        try:
            response = await client.post(
                profile.endpoint,
                headers={"Authorization": f"Bearer {api_key}"},
                json=body,
            )
            check_http_response(response)
            payload = response.json()
            if responses_api:
                text = extract_response_text(payload)
                if not text:
                    raise RuntimeError("Responses API 没有返回可读取的文本内容。")
                return text
            return str(payload["choices"][0]["message"]["content"])
        finally:
            if owned:
                await client.aclose()

