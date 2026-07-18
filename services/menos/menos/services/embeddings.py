"""Embedding generation service using Ollama."""

import httpx

from menos.config import settings


class EmbeddingService:
    """Service for generating embeddings via Ollama."""

    QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

    def __init__(self, base_url: str, model: str):
        """Initialize embedding service.

        Args:
            base_url: Ollama API base URL
            model: Model name to use for embeddings
        """
        self.base_url = base_url
        self.model = model
        self.client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        """Lazy initialize HTTP client."""
        if self.client is None:
            self.client = httpx.AsyncClient(base_url=self.base_url)
        return self.client

    async def embed(self, text: str) -> list[float]:
        """Generate embedding for text.

        Args:
            text: Text to embed

        Returns:
            List of floats representing the embedding vector

        Raises:
            RuntimeError: If embedding generation fails
        """
        try:
            client = await self._get_client()
            response = await client.post(
                "/api/embeddings",
                json={"model": self.model, "prompt": text},
            )
            response.raise_for_status()
            data = response.json()
            return data.get("embedding", [])
        except httpx.HTTPError as e:
            raise RuntimeError(f"Embedding generation failed: {e}") from e

    async def embed_batch(self, texts: list[str]) -> list[list[float]]:
        """Generate embeddings for multiple texts.

        Args:
            texts: List of texts to embed

        Returns:
            List of embedding vectors

        Raises:
            RuntimeError: If embedding generation fails
        """
        embeddings = []
        for text in texts:
            embedding = await self.embed(text)
            embeddings.append(embedding)
        return embeddings

    async def embed_query(self, text: str) -> list[float]:
        """Embed search query with asymmetric prefix.

        Args:
            text: Query text to embed

        Returns:
            List of floats representing the embedding vector

        Raises:
            RuntimeError: If embedding generation fails
        """
        return await self.embed(f"{self.QUERY_PREFIX}{text}")

    async def embed_document(self, text: str) -> list[float]:
        """Embed document (no prefix).

        Args:
            text: Document text to embed

        Returns:
            List of floats representing the embedding vector

        Raises:
            RuntimeError: If embedding generation fails
        """
        return await self.embed(text)

    async def close(self) -> None:
        """Close the HTTP client."""
        if self.client is not None:
            await self.client.aclose()


def get_embedding_service() -> EmbeddingService:
    """Get embedding service instance for dependency injection."""
    return EmbeddingService(settings.ollama_url, settings.ollama_model)
