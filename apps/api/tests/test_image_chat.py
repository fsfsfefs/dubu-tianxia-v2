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


def test_chat_forwards_images_in_current_source_mode():
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
        assert len(captured) == 1

@pytest.mark.parametrize("responses", [False, True])
def test_complete_passes_image_content_for_search_planning(responses):
    captured = []
    def handler(request):
        captured.append(json.loads(request.content))
        payload = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "虚拟内存 缺页中断"}]}]} if responses else {"choices": [{"message": {"content": "虚拟内存 缺页中断"}}]}
        return httpx.Response(200, json=payload)
    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            profile = ModelProfile("model", "Vision", "https://example.com/" + ("responses" if responses else "chat/completions"), "vision")
            return await OpenAICompatibleProvider(client).complete(profile, "key", system="提取关键词", prompt="解答这道题", images=[image_url()])
    assert asyncio.run(run()) == "虚拟内存 缺页中断"
    parts = captured[0]["input" if responses else "messages"][-1]["content"]
    assert parts[1] == ({"type": "input_image", "image_url": image_url()} if responses else {"type": "image_url", "image_url": {"url": image_url()}})


@pytest.mark.parametrize("deep", [False, True])
def test_image_question_drives_rag_and_reaches_answer_and_deep_planner(deep):
    from reader_next_api.visual_context import VISUAL_QUERY
    from reader_next_api.reading_agent import PLANNER
    profile = ModelProfile("model", "Vision", "https://example.com/chat/completions", "vision")
    searches, answers, calls = [], [], []
    async def complete(*args, system, prompt, **kwargs):
        calls.append((system, kwargs))
        if system == VISUAL_QUERY:
            assert kwargs["images"] == [image_url()]
            return "虚拟内存 缺页中断"
        if system == PLANNER:
            assert kwargs["images"] == [image_url()]
            return '{"done":true}'
        return '{"checks":[]}'
    async def stream(*args, **kwargs):
        answers.append(kwargs)
        yield "虚拟内存使用磁盘辅助内存管理。[教材甲｜PDF第10页]"
    def search(ids, query, limit):
        searches.append(query)
        return [{"document_id":"a","document_title":"教材甲","page_number":10,"content":"虚拟内存使用磁盘辅助内存管理。","score":1}]
    repo = SimpleNamespace(profile=lambda _:profile, search_rag_many=search, rag_status_many=lambda _:{"indexed_pages":10,"chunk_count":1}, list_documents=lambda:[{"id":"a","title":"教材甲"}])
    runtime = SimpleNamespace(repository=repo, credential_store=SimpleNamespace(get=lambda _:"key"), provider=SimpleNamespace(stream=stream,complete=complete))
    app=FastAPI();app.include_router(create_router(runtime))
    with TestClient(app) as client:
        result=client.post("/api/chat/stream",json={"profile_id":"model","document_ids":["a"],"question":"解答这道题","images":[image_url()],"use_rag":True,"use_agent":deep,"persist_history":False})
    assert result.status_code == 200
    assert '"type": "error"' not in result.text
    assert "虚拟内存 缺页中断" in searches[0]
    assert answers[0]["images"] == [image_url()]
    assert "教材甲" in answers[0]["rag_context"]
    assert "不核验附图本身" in result.text
    assert len(calls) + len(answers) <= (4 if deep else 3)
