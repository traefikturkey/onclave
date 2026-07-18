"""Unit tests for cloud LLM providers (OpenAI, Anthropic, OpenRouter, NoOp)."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from menos.services.llm import LLMProvider
from menos.services.llm_providers import (
    AnthropicProvider,
    FallbackProvider,
    NoOpLLMProvider,
    OpenAIProvider,
    OpenRouterProvider,
)

# -- OpenAIProvider ----------------------------------------------------------


class TestOpenAIProviderInit:
    """Tests for OpenAIProvider initialization."""

    def test_init_defaults(self):
        """Default model is gpt-4o-mini."""
        p = OpenAIProvider(api_key="sk-test")
        assert p.api_key == "sk-test"
        assert p.model == "gpt-4o-mini"
        assert p.base_url == "https://api.openai.com/v1"
        assert p.client is None

    def test_init_custom_model(self):
        """Custom model is stored."""
        p = OpenAIProvider(api_key="sk-test", model="gpt-4-turbo")
        assert p.model == "gpt-4-turbo"

    def test_satisfies_protocol(self):
        """OpenAIProvider satisfies LLMProvider protocol."""
        assert isinstance(OpenAIProvider(api_key="k"), LLMProvider)


class TestOpenAIProviderGetClient:
    """Tests for lazy client initialization."""

    @pytest.mark.asyncio
    async def test_creates_client_with_headers(self):
        """Client includes Authorization and Content-Type headers."""
        p = OpenAIProvider(api_key="sk-abc")
        client = await p._get_client()
        assert client is not None
        assert "authorization" in client.headers
        assert client.headers["authorization"] == "Bearer sk-abc"
        await p.close()

    @pytest.mark.asyncio
    async def test_returns_same_client(self):
        """Subsequent calls return the same client."""
        p = OpenAIProvider(api_key="sk-abc")
        c1 = await p._get_client()
        c2 = await p._get_client()
        assert c1 is c2
        await p.close()


class TestOpenAIProviderGenerate:
    """Tests for generate method."""

    @pytest.mark.asyncio
    async def test_success_without_system_prompt(self):
        """Returns content from choices[0].message.content."""
        p = OpenAIProvider(api_key="sk-test", model="gpt-4o-mini")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "Hello from OpenAI"}}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        result = await p.generate("Say hi")
        assert result == "Hello from OpenAI"

        payload = mock_client.post.call_args.kwargs["json"]
        assert payload["messages"] == [{"role": "user", "content": "Say hi"}]

    @pytest.mark.asyncio
    async def test_success_with_system_prompt(self):
        """System prompt prepended as system message."""
        p = OpenAIProvider(api_key="sk-test")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "ok"}}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        await p.generate("prompt", system_prompt="Be concise")

        payload = mock_client.post.call_args.kwargs["json"]
        assert payload["messages"][0] == {
            "role": "system",
            "content": "Be concise",
        }
        assert payload["messages"][1] == {
            "role": "user",
            "content": "prompt",
        }

    @pytest.mark.asyncio
    async def test_custom_params_forwarded(self):
        """max_tokens, temperature, timeout forwarded correctly."""
        p = OpenAIProvider(api_key="sk-test")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "ok"}}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        await p.generate(
            "p", max_tokens=50, temperature=0.1, timeout=5.0
        )

        call = mock_client.post.call_args
        assert call.kwargs["json"]["max_tokens"] == 50
        assert call.kwargs["json"]["temperature"] == 0.1
        assert call.kwargs["timeout"] == 5.0

    @pytest.mark.asyncio
    async def test_retries_on_http_error(self):
        """Retries and returns result on second attempt."""
        p = OpenAIProvider(api_key="sk-test")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "recovered"}}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.side_effect = [
            httpx.HTTPError("rate limit"),
            mock_resp,
        ]
        p.client = mock_client

        with patch(
            "menos.services.llm_providers.asyncio.sleep",
            new_callable=AsyncMock,
        ):
            result = await p.generate("prompt")

        assert result == "recovered"
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_raises_after_max_retries(self):
        """Raises RuntimeError after 3 failed attempts."""
        p = OpenAIProvider(api_key="sk-test")

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPError("server error")
        p.client = mock_client

        with (
            patch(
                "menos.services.llm_providers.asyncio.sleep",
                new_callable=AsyncMock,
            ),
            pytest.raises(
                RuntimeError,
                match="OpenAI generation failed after 3 retries",
            ),
        ):
            await p.generate("prompt")

        assert mock_client.post.call_count == 3


class TestOpenAIProviderClose:
    """Tests for close method."""

    @pytest.mark.asyncio
    async def test_close_with_client(self):
        """close() calls aclose and sets client to None."""
        p = OpenAIProvider(api_key="sk-test")
        mock_client = AsyncMock()
        p.client = mock_client

        await p.close()
        mock_client.aclose.assert_called_once()
        assert p.client is None

    @pytest.mark.asyncio
    async def test_close_without_client(self):
        """close() is safe when client is None."""
        p = OpenAIProvider(api_key="sk-test")
        await p.close()
        assert p.client is None


# -- AnthropicProvider -------------------------------------------------------


class TestAnthropicProviderInit:
    """Tests for AnthropicProvider initialization."""

    def test_init_defaults(self):
        """Default model and base_url."""
        p = AnthropicProvider(api_key="sk-ant-test")
        assert p.api_key == "sk-ant-test"
        assert p.model == "claude-3-5-haiku-20241022"
        assert p.base_url == "https://api.anthropic.com/v1"
        assert p.client is None

    def test_satisfies_protocol(self):
        """AnthropicProvider satisfies LLMProvider protocol."""
        assert isinstance(AnthropicProvider(api_key="k"), LLMProvider)


class TestAnthropicProviderGetClient:
    """Tests for lazy client initialization."""

    @pytest.mark.asyncio
    async def test_creates_client_with_headers(self):
        """Client includes x-api-key and anthropic-version headers."""
        p = AnthropicProvider(api_key="sk-ant-abc")
        client = await p._get_client()
        assert "x-api-key" in client.headers
        assert client.headers["x-api-key"] == "sk-ant-abc"
        assert client.headers["anthropic-version"] == "2023-06-01"
        await p.close()


class TestAnthropicProviderGenerate:
    """Tests for generate method."""

    @pytest.mark.asyncio
    async def test_success_without_system_prompt(self):
        """Returns text from content[0].text."""
        p = AnthropicProvider(api_key="sk-ant-test")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "content": [{"text": "Hello from Anthropic"}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        result = await p.generate("Say hi")
        assert result == "Hello from Anthropic"

        payload = mock_client.post.call_args.kwargs["json"]
        assert "system" not in payload
        assert payload["messages"] == [
            {"role": "user", "content": "Say hi"}
        ]

    @pytest.mark.asyncio
    async def test_success_with_system_prompt(self):
        """System prompt added as top-level 'system' field."""
        p = AnthropicProvider(api_key="sk-ant-test")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "content": [{"text": "ok"}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        await p.generate("prompt", system_prompt="Be helpful")

        payload = mock_client.post.call_args.kwargs["json"]
        assert payload["system"] == "Be helpful"

    @pytest.mark.asyncio
    async def test_raises_after_max_retries(self):
        """Raises RuntimeError after 3 failed attempts."""
        p = AnthropicProvider(api_key="sk-ant-test")

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPError("timeout")
        p.client = mock_client

        with (
            patch(
                "menos.services.llm_providers.asyncio.sleep",
                new_callable=AsyncMock,
            ),
            pytest.raises(
                RuntimeError,
                match="Anthropic generation failed after 3 retries",
            ),
        ):
            await p.generate("prompt")

        assert mock_client.post.call_count == 3


class TestAnthropicProviderClose:
    """Tests for close method."""

    @pytest.mark.asyncio
    async def test_close_with_client(self):
        """close() calls aclose and sets client to None."""
        p = AnthropicProvider(api_key="k")
        mock_client = AsyncMock()
        p.client = mock_client

        await p.close()
        mock_client.aclose.assert_called_once()
        assert p.client is None

    @pytest.mark.asyncio
    async def test_close_without_client(self):
        """close() is safe when client is None."""
        p = AnthropicProvider(api_key="k")
        await p.close()
        assert p.client is None


# -- OpenRouterProvider ------------------------------------------------------


class TestOpenRouterProviderInit:
    """Tests for OpenRouterProvider initialization."""

    def test_init_defaults(self):
        """Default model and base_url."""
        p = OpenRouterProvider(api_key="or-test")
        assert p.api_key == "or-test"
        assert p.model == "openai/gpt-4o-mini"
        assert p.base_url == "https://openrouter.ai/api/v1"
        assert p.client is None

    def test_satisfies_protocol(self):
        """OpenRouterProvider satisfies LLMProvider protocol."""
        assert isinstance(OpenRouterProvider(api_key="k"), LLMProvider)


class TestOpenRouterProviderGetClient:
    """Tests for lazy client initialization."""

    @pytest.mark.asyncio
    async def test_creates_client_with_headers(self):
        """Client includes Authorization and HTTP-Referer headers."""
        p = OpenRouterProvider(api_key="or-abc")
        client = await p._get_client()
        assert client.headers["authorization"] == "Bearer or-abc"
        assert client.headers["http-referer"] == "menos"
        await p.close()


class TestOpenRouterProviderGenerate:
    """Tests for generate method."""

    @pytest.mark.asyncio
    async def test_success_chat_completions_format(self):
        """Uses OpenAI-compatible chat completions format."""
        p = OpenRouterProvider(api_key="or-test", model="meta/llama-3")

        mock_resp = MagicMock()
        mock_resp.json.return_value = {
            "choices": [{"message": {"content": "Hello from OR"}}]
        }
        mock_resp.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_resp
        p.client = mock_client

        result = await p.generate("Say hi")
        assert result == "Hello from OR"

        call_args = mock_client.post.call_args
        assert call_args.args[0] == "/chat/completions"
        assert call_args.kwargs["json"]["model"] == "meta/llama-3"

    @pytest.mark.asyncio
    async def test_raises_after_max_retries(self):
        """Raises RuntimeError after 3 failed attempts."""
        p = OpenRouterProvider(api_key="or-test")

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPError("503")
        p.client = mock_client

        with (
            patch(
                "menos.services.llm_providers.asyncio.sleep",
                new_callable=AsyncMock,
            ),
            pytest.raises(
                RuntimeError,
                match="OpenRouter generation failed after 3 retries",
            ),
        ):
            await p.generate("prompt")


class TestOpenRouterProviderClose:
    """Tests for close method."""

    @pytest.mark.asyncio
    async def test_close_with_client(self):
        """close() calls aclose and sets client to None."""
        p = OpenRouterProvider(api_key="k")
        mock_client = AsyncMock()
        p.client = mock_client

        await p.close()
        mock_client.aclose.assert_called_once()
        assert p.client is None


# -- NoOpLLMProvider ---------------------------------------------------------


class TestNoOpLLMProvider:
    """Tests for NoOpLLMProvider."""

    def test_init_defaults(self):
        """Accepts and stores api_key and model for interface compat."""
        p = NoOpLLMProvider()
        assert p.api_key == ""
        assert p.model == "noop"

    def test_init_custom(self):
        """Custom api_key and model are stored."""
        p = NoOpLLMProvider(api_key="ignored", model="also-ignored")
        assert p.api_key == "ignored"
        assert p.model == "also-ignored"

    def test_satisfies_protocol(self):
        """NoOpLLMProvider satisfies LLMProvider protocol."""
        assert isinstance(NoOpLLMProvider(), LLMProvider)

    @pytest.mark.asyncio
    async def test_generate_returns_empty(self):
        """generate() always returns empty string."""
        p = NoOpLLMProvider()
        result = await p.generate(
            "any prompt",
            system_prompt="any system",
            max_tokens=999,
            temperature=1.5,
            timeout=30.0,
        )
        assert result == ""

    @pytest.mark.asyncio
    async def test_close_is_noop(self):
        """close() does nothing and does not raise."""
        p = NoOpLLMProvider()
        await p.close()  # Should not raise


# -- FallbackProvider (supplement existing tests) ----------------------------


class TestFallbackProviderProtocol:
    """Protocol compliance for FallbackProvider."""

    def test_satisfies_protocol(self):
        """FallbackProvider satisfies LLMProvider protocol."""
        noop = NoOpLLMProvider()
        fb = FallbackProvider([("noop", noop)])
        assert isinstance(fb, LLMProvider)
