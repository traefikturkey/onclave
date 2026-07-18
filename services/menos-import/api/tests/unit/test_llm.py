"""Unit tests for OllamaLLMProvider and LLM protocol."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from menos.services.llm import LLMProvider, OllamaLLMProvider


class TestLLMProtocol:
    """Tests for LLMProvider protocol compliance."""

    def test_ollama_provider_is_llm_provider(self):
        """OllamaLLMProvider satisfies the LLMProvider protocol."""
        provider = OllamaLLMProvider("http://localhost:11434", "test-model")
        assert isinstance(provider, LLMProvider)


class TestOllamaLLMProviderInit:
    """Tests for OllamaLLMProvider initialization."""

    def test_init_stores_url_and_model(self):
        """Constructor stores base_url (stripped) and model."""
        provider = OllamaLLMProvider("http://host:11434/", "llama3")
        assert provider.base_url == "http://host:11434"
        assert provider.model == "llama3"
        assert provider.client is None

    def test_init_strips_trailing_slashes(self):
        """All trailing slashes are stripped from base_url."""
        provider = OllamaLLMProvider("http://host:11434///", "m")
        assert provider.base_url == "http://host:11434"


class TestOllamaLLMProviderGetClient:
    """Tests for lazy client initialization."""

    @pytest.mark.asyncio
    async def test_get_client_creates_client(self):
        """First call creates an httpx.AsyncClient."""
        provider = OllamaLLMProvider("http://localhost:11434", "m")
        client = await provider._get_client()
        assert client is not None
        assert isinstance(client, httpx.AsyncClient)
        await provider.close()

    @pytest.mark.asyncio
    async def test_get_client_returns_same_instance(self):
        """Subsequent calls return the same client instance."""
        provider = OllamaLLMProvider("http://localhost:11434", "m")
        c1 = await provider._get_client()
        c2 = await provider._get_client()
        assert c1 is c2
        await provider.close()


class TestOllamaLLMProviderGenerate:
    """Tests for the generate method."""

    @pytest.mark.asyncio
    async def test_generate_success(self):
        """Successful generation returns response text."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response = MagicMock()
        mock_response.json.return_value = {"response": "Hello world"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        provider.client = mock_client

        result = await provider.generate("Say hello")

        assert result == "Hello world"
        mock_client.post.assert_called_once_with(
            "/api/generate",
            json={
                "model": "llama3",
                "prompt": "Say hello",
                "stream": False,
                "options": {
                    "num_predict": 4096,
                    "temperature": 0.7,
                },
            },
            timeout=60.0,
        )

    @pytest.mark.asyncio
    async def test_generate_with_system_prompt(self):
        """System prompt is included in the payload when provided."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response = MagicMock()
        mock_response.json.return_value = {"response": "ok"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        provider.client = mock_client

        await provider.generate("prompt", system_prompt="Be helpful")

        call_payload = mock_client.post.call_args.kwargs["json"]
        assert call_payload["system"] == "Be helpful"

    @pytest.mark.asyncio
    async def test_generate_without_system_prompt(self):
        """No system key in payload when system_prompt is None."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response = MagicMock()
        mock_response.json.return_value = {"response": "ok"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        provider.client = mock_client

        await provider.generate("prompt")

        call_payload = mock_client.post.call_args.kwargs["json"]
        assert "system" not in call_payload

    @pytest.mark.asyncio
    async def test_generate_custom_params(self):
        """Custom max_tokens, temperature, timeout are forwarded."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response = MagicMock()
        mock_response.json.return_value = {"response": "ok"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        provider.client = mock_client

        await provider.generate(
            "p",
            max_tokens=100,
            temperature=0.2,
            timeout=10.0,
        )

        call_args = mock_client.post.call_args
        assert call_args.kwargs["json"]["options"]["num_predict"] == 100
        assert call_args.kwargs["json"]["options"]["temperature"] == 0.2
        assert call_args.kwargs["timeout"] == 10.0

    @pytest.mark.asyncio
    async def test_generate_missing_response_key(self):
        """Returns empty string when 'response' key is missing."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response = MagicMock()
        mock_response.json.return_value = {"other": "data"}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        provider.client = mock_client

        result = await provider.generate("prompt")
        assert result == ""

    @pytest.mark.asyncio
    async def test_generate_retries_on_http_error(self):
        """Retries on HTTPError with exponential backoff."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_response_ok = MagicMock()
        mock_response_ok.json.return_value = {"response": "recovered"}
        mock_response_ok.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.side_effect = [
            httpx.HTTPError("timeout"),
            mock_response_ok,
        ]
        provider.client = mock_client

        with patch("menos.services.llm.asyncio.sleep", new_callable=AsyncMock):
            result = await provider.generate("prompt")

        assert result == "recovered"
        assert mock_client.post.call_count == 2

    @pytest.mark.asyncio
    async def test_generate_raises_after_max_retries(self):
        """Raises RuntimeError after 3 failed retries."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPError("connection refused")
        provider.client = mock_client

        with (
            patch("menos.services.llm.asyncio.sleep", new_callable=AsyncMock),
            pytest.raises(RuntimeError, match="LLM generation failed after 3 retries"),
        ):
            await provider.generate("prompt")

        assert mock_client.post.call_count == 3

    @pytest.mark.asyncio
    async def test_generate_exponential_backoff_delays(self):
        """Backoff delays are 1s, 2s for first two retries."""
        provider = OllamaLLMProvider("http://localhost:11434", "llama3")

        mock_client = AsyncMock()
        mock_client.post.side_effect = httpx.HTTPError("fail")
        provider.client = mock_client

        mock_sleep = AsyncMock()
        with (
            patch("menos.services.llm.asyncio.sleep", mock_sleep),
            pytest.raises(RuntimeError),
        ):
            await provider.generate("prompt")

        # 3 attempts, sleep called after attempt 0 and 1 (not after last)
        assert mock_sleep.call_count == 2
        mock_sleep.assert_any_call(1.0)  # 1.0 * 2^0
        mock_sleep.assert_any_call(2.0)  # 1.0 * 2^1


class TestOllamaLLMProviderClose:
    """Tests for resource cleanup."""

    @pytest.mark.asyncio
    async def test_close_with_client(self):
        """close() calls aclose on the client and sets it to None."""
        provider = OllamaLLMProvider("http://localhost:11434", "m")
        mock_client = AsyncMock()
        provider.client = mock_client

        await provider.close()

        mock_client.aclose.assert_called_once()
        assert provider.client is None

    @pytest.mark.asyncio
    async def test_close_without_client(self):
        """close() is safe when client is None."""
        provider = OllamaLLMProvider("http://localhost:11434", "m")
        assert provider.client is None
        await provider.close()  # Should not raise
        assert provider.client is None
