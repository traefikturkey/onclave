"""Unit tests for embedding service."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.embeddings import EmbeddingService


class TestEmbeddingService:
    """Tests for embedding generation."""

    def test_init(self):
        """Test service initialization."""
        service = EmbeddingService("http://localhost:11434", "mxbai-embed-large")

        assert service.base_url == "http://localhost:11434"
        assert service.model == "mxbai-embed-large"

    @pytest.mark.asyncio
    async def test_embed(self):
        """Test embedding generation."""
        service = EmbeddingService("http://localhost:11434", "mxbai-embed-large")

        # response.json() is synchronous in httpx, so use MagicMock for response
        mock_response = MagicMock()
        mock_response.json.return_value = {"embedding": [0.1, 0.2, 0.3]}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        service.client = mock_client

        result = await service.embed("test text")

        assert result == [0.1, 0.2, 0.3]
        mock_client.post.assert_called_once()

    @pytest.mark.asyncio
    async def test_embed_batch(self):
        """Test batch embedding generation."""
        service = EmbeddingService("http://localhost:11434", "mxbai-embed-large")

        # response.json() is synchronous in httpx, so use MagicMock for response
        mock_response = MagicMock()
        mock_response.json.return_value = {"embedding": [0.1, 0.2, 0.3]}
        mock_response.raise_for_status = MagicMock()

        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        service.client = mock_client

        results = await service.embed_batch(["text1", "text2"])

        assert len(results) == 2
        assert all(r == [0.1, 0.2, 0.3] for r in results)

    @pytest.mark.asyncio
    async def test_close(self):
        """Test client close."""
        service = EmbeddingService("http://localhost:11434", "mxbai-embed-large")
        mock_client = AsyncMock()
        service.client = mock_client

        await service.close()

        mock_client.aclose.assert_called_once()
