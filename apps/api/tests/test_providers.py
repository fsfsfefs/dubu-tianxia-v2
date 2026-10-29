import httpx

from reader_next_api.domain import ModelProfile
from reader_next_api.providers import (
    build_request_body,
    extract_response_text,
    extract_stream_delta,
    provider_error_message,
)


def test_connection_error_is_actionable():
    request = httpx.Request("POST", "https://example.com/chat/completions")
    error = httpx.ConnectError("All connection attempts failed", request=request)

    assert "无法连接模型服务" in provider_error_message(error)


def test_unauthorized_error_mentions_api_key():
    request = httpx.Request("POST", "https://example.com/chat/completions")
    response = httpx.Response(401, request=request)
    error = httpx.HTTPStatusError("401", request=request, response=response)

    assert "API Key" in provider_error_message(error)


def responses_profile() -> ModelProfile:
    return ModelProfile(
        "responses-id",
        "Responses 模型",
        "https://ark.cn-beijing.volces.com/api/v3/responses",
        "deepseek-v4-1-flash-economy-261017",
        max_tokens=8100,
    )


def test_responses_complete_uses_input_and_extracts_output_text():
    body = build_request_body(
        responses_profile(),
        [{"role": "system", "content": "系统"}, {"role": "user", "content": "测试"}],
        stream=False,
    )
    payload = {"output": [{"type": "message", "content": [{"type": "output_text", "text": "OK"}]}]}

    assert extract_response_text(payload) == "OK"
    assert "input" in body
    assert "messages" not in body
    assert body["max_output_tokens"] == 8100
    assert "max_tokens" not in body


def test_responses_stream_reads_output_text_delta():
    body = build_request_body(responses_profile(), [{"role": "user", "content": "问题"}], stream=True)
    first = extract_stream_delta({"type": "response.output_text.delta", "delta": "你"}, True)
    second = extract_stream_delta({"type": "response.output_text.delta", "delta": "好"}, True)

    assert first + second == "你好"
    assert body["stream"] is True
    assert body["max_output_tokens"] == 8100


def test_bad_request_includes_provider_detail():
    request = httpx.Request("POST", "https://example.com/responses")
    response = httpx.Response(400, request=request, json={"error": {"message": "unsupported field"}})
    error = httpx.HTTPStatusError("400", request=request, response=response)

    assert "unsupported field" in provider_error_message(error)
import json
import pytest
from reader_next_api.providers import OpenAICompatibleProvider


def run_immediate(coroutine):
    try:
        coroutine.send(None)
    except StopIteration as done:
        return done.value
    finally:
        coroutine.close()
    raise AssertionError('Mock response unexpectedly suspended')


def collect_stream(events):
    class Response:
        status_code = 200
        def raise_for_status(self):
            pass
        async def aiter_lines(self):
            for event in events:
                yield 'data: ' + (event if isinstance(event, str) else json.dumps(event))
    class Stream:
        async def __aenter__(self):
            return Response()
        async def __aexit__(self, *args):
            pass
    class Client:
        def stream(self, *args, **kwargs):
            return Stream()
    async def collect():
        return ''.join([part async for part in OpenAICompatibleProvider(Client()).stream(
            responses_profile(), 'test-key', excerpt='text', question='summary', history=[]
        )])
    return run_immediate(collect())


def test_stream_recovers_final_response_without_duplicating_deltas():
    final = {'type': 'response.completed', 'response': {'output_text': 'hello'}}
    assert collect_stream([final, '[DONE]']) == 'hello'
    assert collect_stream([{'type': 'response.output_text.delta', 'delta': 'hel'}, final]) == 'hello'
    assert collect_stream([{'type': 'response.output_text.delta', 'delta': 'hello'}, final]) == 'hello'


def test_stream_reports_output_budget_exhaustion():
    with pytest.raises(RuntimeError, match='Token'):
        collect_stream([{'type': 'response.incomplete', 'response': {
            'incomplete_details': {'reason': 'max_output_tokens'}}}])


def test_stream_rejects_empty_success_and_provider_errors():
    with pytest.raises(RuntimeError, match='正文'):
        collect_stream(['[DONE]'])
    with pytest.raises(RuntimeError, match='quota exceeded'):
        collect_stream([{'error': {'message': 'quota exceeded'}}])


def test_stream_rejects_silent_truncation():
    with pytest.raises(httpx.RemoteProtocolError):
        collect_stream([{'type': 'response.output_text.delta', 'delta': '残缺正文'}])


def test_transport_error_message_is_readable_and_token_limit_is_not_success():
    assert '提前关闭' in provider_error_message(httpx.RemoteProtocolError('incomplete chunked read'))
    with pytest.raises(RuntimeError, match='输出额度'):
        extract_stream_delta({'choices': [{'delta': {}, 'finish_reason': 'length'}]}, False)


def test_completed_response_does_not_wait_for_broken_http_trailer():
    class Events:
        def __iter__(self):
            yield {'type': 'response.completed', 'response': {'output_text': '完整正文'}}
            raise httpx.RemoteProtocolError('incomplete chunked read after completion')
    assert collect_stream(Events()) == '完整正文'


@pytest.mark.parametrize('reason', ['max_tokens', 'max_output_tokens', 'length'])
def test_incomplete_budget_aliases(reason):
    from reader_next_api.providers import IncompleteModelResponse
    with pytest.raises(IncompleteModelResponse, match='输出额度') as caught:
        extract_stream_delta({'type': 'response.incomplete', 'response': {'id': 'resp-budget', 'incomplete_details': {'reason': reason}}}, True)
    assert caught.value.retryable is False


def test_incomplete_reason_and_id_are_preserved_and_filter_is_not_retryable():
    from reader_next_api.providers import IncompleteModelResponse
    with pytest.raises(IncompleteModelResponse) as caught:
        collect_stream([{'type': 'response.incomplete', 'response': {'id': 'resp-filter', 'incomplete_details': {'reason': 'content_filter'}}}])
    assert '内容审核' in str(caught.value) and 'resp-filter' in str(caught.value)
    assert caught.value.retryable is False
    with pytest.raises(IncompleteModelResponse, match='unknown'):
        extract_stream_delta({'type': 'response.incomplete', 'response': {'incomplete_details': None}}, True)
    with pytest.raises(IncompleteModelResponse, match='content_filter'):
        extract_stream_delta({'type': 'response.completed', 'response': {'status': 'incomplete', 'incomplete_details': {'content_filter': {'type': 'example'}}}}, True)


def test_known_transient_incomplete_is_retryable():
    from reader_next_api.providers import IncompleteModelResponse
    error = IncompleteModelResponse({'incomplete_details': {'reason': 'server_error'}})
    assert error.retryable and 'server_error' in str(error)


def test_burst_classification_for_http_and_all_stream_error_shapes():
    from reader_next_api.providers import ModelRateLimitError, check_http_response
    error = {'code': 'RequestBurstTooFast', 'message': 'System protection triggered by request burst. Please slow down traffic growth.'}
    for event in [
        {'error': error},
        {'type': 'error', **error},
        {'type': 'response.failed', 'response': {'error': error}},
    ]:
        with pytest.raises(ModelRateLimitError, match='突增保护'):
            extract_stream_delta(event, True)
    response = httpx.Response(429, headers={'Retry-After': '90'}, json={'error': error}, request=httpx.Request('POST', 'https://example.com'))
    with pytest.raises(ModelRateLimitError) as caught:
        check_http_response(response)
    assert caught.value.retry_after == 90


def test_insufficient_quota_is_not_a_transient_burst():
    from reader_next_api.providers import rate_limit_error
    assert rate_limit_error({'error': {'code': 'insufficient_quota', 'message': 'credit balance too low'}}) is None
    assert rate_limit_error({'error': {'code': 'ModelAccountTpmRateLimitExceeded', 'message': 'rate limit'}}) is not None
    assert rate_limit_error({'error': {'code': 'RequestBurstTooFast'}}, 'nan').retry_after == 0


def test_http_content_rejection_is_classified_but_bad_parameters_are_not():
    from reader_next_api.providers import ModelContentFilterError, check_http_response
    request = httpx.Request('POST', 'https://example.com')
    rejected = httpx.Response(400, request=request, json={'error': {'message': 'The request failed because the input text may contain sensitive information.'}})
    with pytest.raises(ModelContentFilterError):
        check_http_response(rejected)
    invalid = httpx.Response(400, request=request, json={'error': {'message': 'Unsupported parameter temperature'}})
    with pytest.raises(httpx.HTTPStatusError):
        check_http_response(invalid)
