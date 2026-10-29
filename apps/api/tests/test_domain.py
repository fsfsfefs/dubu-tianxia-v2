import pytest

from reader_next_api.domain import ModelProfile, normalize_chat_completions_endpoint


def profile(endpoint="https://example.com/v1/chat/completions"):
    return ModelProfile("id", "测试模型", endpoint, "model-id")


def test_valid_https_and_loopback_profiles():
    profile().validate()
    profile("http://127.0.0.1:11434/v1/chat/completions").validate()


def test_remote_plain_http_is_rejected():
    with pytest.raises(ValueError, match="HTTPS"):
        profile("http://example.com/v1/chat/completions").validate()


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("https://api.deepseek.com", "https://api.deepseek.com/chat/completions"),
        ("https://example.com/v1/", "https://example.com/v1/chat/completions"),
        (
            "https://example.com/custom/chat/completions",
            "https://example.com/custom/chat/completions",
        ),
        (
            "https://ark.cn-beijing.volces.com/api/v3/responses",
            "https://ark.cn-beijing.volces.com/api/v3/responses",
        ),
    ],
)
def test_normalize_chat_completions_endpoint(value, expected):
    assert normalize_chat_completions_endpoint(value) == expected

