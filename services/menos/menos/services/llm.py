"""LLM service for text generation using Ollama."""

import asyncio
from typing import Protocol, runtime_checkable

import httpx


@runtime_checkable
class LLMProvider(Protocol):
    """Protocol defining the interface for LLM providers."""

    async def generate(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        timeout: float = 60.0,
    ) -> str:
        """Generate text from a prompt.

        Args:
            prompt: The prompt to generate from
            system_prompt: Optional system prompt to guide generation
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature (0.0-2.0)
            timeout: Request timeout in seconds

        Returns:
            Generated text response
        """
        ...

    async def close(self) -> None:
        """Close and cleanup resources."""
        ...


class OllamaLLMProvider:
    """LLM provider implementation using Ollama API."""

    def __init__(self, base_url: str, model: str):
        """Initialize Ollama LLM provider.

        Args:
            base_url: Ollama API base URL
            model: Model name to use for generation
        """
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Lazy initialize HTTP client with connection pooling."""
        if self.client is None:
            self.client = httpx.AsyncClient(base_url=self.base_url)
        return self.client

    async def generate(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        timeout: float = 60.0,
    ) -> str:
        """Generate text from a prompt with retry logic.

        Args:
            prompt: The prompt to generate from
            system_prompt: Optional system prompt to guide generation
            max_tokens: Maximum tokens to generate
            temperature: Sampling temperature (0.0-2.0)
            timeout: Request timeout in seconds

        Returns:
            Generated text response

        Raises:
            RuntimeError: If generation fails after all retries
        """
        max_retries = 3
        base_delay = 1.0

        for attempt in range(max_retries):
            try:
                client = await self._get_client()

                # Build request payload
                payload: dict = {
                    "model": self.model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {
                        "num_predict": max_tokens,
                        "temperature": temperature,
                    },
                }

                if system_prompt is not None:
                    payload["system"] = system_prompt

                response = await client.post(
                    "/api/generate",
                    json=payload,
                    timeout=timeout,
                )
                response.raise_for_status()
                data = response.json()
                return data.get("response", "")

            except httpx.HTTPError as e:
                if attempt == max_retries - 1:
                    msg = f"LLM generation failed after {max_retries} retries: {e}"
                    raise RuntimeError(msg) from e

                # Exponential backoff: 1s, 2s, 4s
                delay = base_delay * (2**attempt)
                await asyncio.sleep(delay)

        return ""

    async def close(self) -> None:
        """Close the HTTP client and cleanup resources."""
        if self.client is not None:
            await self.client.aclose()
            self.client = None
