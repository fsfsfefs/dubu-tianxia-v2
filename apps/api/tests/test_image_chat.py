import asyncio
import base64
import json
from io import BytesIO
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image
from pydantic import ValidationError
from fastapi import FastAPI
from fastapi.testclient import TestClient

from reader_next_api.schemas import ChatInput
from reader_next_api.domain import ModelProfile
from reader_next_api.providers import OpenAICompatibleProvider
from reader_next_api.routes.chat import create_router


def image_url():
    buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(buffer, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


@pytest.mark.parametrize("url", ["https://example.com/image.png", "data:image/svg+xml;base64,AAAA", "data:image/png;base64,bm90LWFuLWltYWdl", "data:image/jpeg;base64,AAAA", "data:image/png;base64,%%%"])
def test_rejects_remote_unsupported_or_invalid_images(url):
    with pytest.raises(ValidationError):
        ChatInput(profile_id="model", question="image", images=[url])


def test_image_count_size_and_pixel_limits():
    assert ChatInput(profile_id="model", question="image", images=[image_url()]).images
    with pytest.raises(ValidationError):
        ChatInput(profile_id="model", question="image", images=[image_url()] * 5)
    with pytest.raises(ValidationError):
        ChatInput(profile_id="model", question="image", images=["data:image/png;base64," + "A" * (4 * 1024 * 1024 + 4)])
    buffer = BytesIO()
    Image.new("1", (5000, 5000)).save(buffer, format="PNG")
    with pytest.raises(ValidationError):
        ChatInput(profile_id="model", question="image", images=["data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()])


@pytest.mark.parametrize("responses", [False, True])
def test_provider_sends_protocol_specific_image_parts(responses):
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        event = {"type": "response.completed", "response": {"output": [{"type": "message", "content": [{"type": "output_text", "text": "图中结论"}]}]}} if responses else {"choices": [{"delta": {"content": "图中结论"}, "finish_reason": "stop"}]}
        return httpx.Response(200, text="data: " + json.dumps(event) + "\n\n")

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = OpenAICompatibleProvider(client)
            profile = ModelProfile("model", "Vision", "https://example.com/" + ("responses" if responses else "chat/completions"), "vision")
            return "".join([delta async for delta in provider.stream(profile, "key", excerpt="", question="图中问题", history=[], images=[image_url()], page_number=3)])
    assert asyncio.run(run()) == "图中结论"
    parts = captured[0]["input" if responses else "messages"][-1]["content"]
    assert parts[0]["type"] == ("input_text" if responses else "text")
    assert "PDF 第 3 页" in parts[0]["text"]
    assert parts[1] == ({"type": "input_image", "image_url": image_url()} if responses else {"type": "image_url", "image_url": {"url": image_url()}})


def test_chat_forwards_images_and_rejects_modes_that_would_drop_them():
    captured = []
    async def stream(*args, **kwargs):
        captured.append(kwargs)
        yield "图中结论"
    runtime = SimpleNamespace(repository=SimpleNamespace(profile=lambda _: SimpleNamespace(id="model")), credential_store=SimpleNamespace(get=lambda _: "key"), provider=SimpleNamespace(stream=stream))
    app = FastAPI()
    app.include_router(create_router(runtime))
    with TestClient(app) as client:
        body = {"profile_id": "model", "question": "图中问题", "images": [image_url()], "persist_history": False}
        response = client.post("/api/chat/stream", json=body)
        assert response.status_code == 200 and "图中结论" in response.text
        assert captured[0]["images"] == [image_url()]
        for flag in ["use_rag", "use_agent", "use_web"]:
            assert client.post("/api/chat/stream", json={**body, flag: True}).status_code == 422
        assert len(captured) == 1
