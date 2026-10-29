from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse, urlsplit, urlunsplit


def normalize_chat_completions_endpoint(endpoint: str) -> str:
    """Accept a provider base URL, Chat Completions URL, or Responses URL."""
    value = endpoint.strip()
    parsed = urlsplit(value)
    path = parsed.path.rstrip("/")
    if path.endswith("/responses") or path.endswith("/chat/completions"):
        return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))
    if not path:
        path = "/chat/completions"
    elif path.endswith("/v1"):
        path += "/chat/completions"
    return urlunsplit((parsed.scheme, parsed.netloc, path, parsed.query, parsed.fragment))


@dataclass(frozen=True, slots=True)
class ModelProfile:
    id: str
    name: str
    endpoint: str
    model: str
    temperature: float = 0.2
    max_tokens: int = 2048
    is_default: bool = False

    def validate(self) -> None:
        parsed = urlparse(self.endpoint)
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ValueError("Endpoint 必须是完整的 HTTP(S) 地址。")
        if parsed.scheme == "http" and parsed.hostname not in {
            "127.0.0.1",
            "localhost",
            "::1",
        }:
            raise ValueError("远程模型 Endpoint 必须使用 HTTPS。")
        if not self.model.strip() or len(self.model) > 160:
            raise ValueError("模型名称无效。")
        if not self.name.strip() or len(self.name) > 80:
            raise ValueError("配置名称无效。")
        if not 0 <= self.temperature <= 2:
            raise ValueError("temperature 必须在 0 到 2 之间。")
        if not 1 <= self.max_tokens <= 16384:
            raise ValueError("max_tokens 必须在 1 到 16384 之间。")

