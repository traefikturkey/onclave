"""Unit tests for GET /api/v1/content endpoint hardening."""

from datetime import datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import ContentMetadata
from menos.routers.content import list_content
from menos.services.storage import SurrealDBRepository


class TestContentListChunkCounts:
    """Tests for chunk_count mapping in content list responses."""

    @pytest.mark.asyncio
    async def test_chunk_counts_mapped_correctly(self):
        """Test that chunk counts are correctly mapped from get_chunk_counts."""
        mock_repo = MagicMock(spec=SurrealDBRepository)

        # Mock content items
        items = [
            ContentMetadata(
                id="content1",
                content_type="youtube",
                title="Video with chunks",
                mime_type="text/plain",
                file_size=1000,
                file_path="youtube/content1/transcript.txt",
                created_at=datetime(2025, 1, 1),
            ),
            ContentMetadata(
                id="content2",
                content_type="document",
                title="Doc without chunks",
                mime_type="text/plain",
                file_size=500,
                file_path="document/content2/file.txt",
                created_at=datetime(2025, 1, 2),
            ),
        ]

        # Mock repository methods
        mock_repo.list_content = AsyncMock(return_value=(items, 2))
        mock_repo.get_chunk_counts = AsyncMock(
            return_value={"content1": 10, "content2": 0}
        )

        result = await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        # Verify chunk counts are correctly mapped
        assert len(result.items) == 2
        assert result.items[0].chunk_count == 10
        assert result.items[1].chunk_count == 0

        # Verify get_chunk_counts was called with correct content IDs
        mock_repo.get_chunk_counts.assert_called_once_with(["content1", "content2"])

    @pytest.mark.asyncio
    async def test_chunk_counts_defaults_to_zero_when_missing(self):
        """Test chunk_count defaults to 0 when content ID not in result dict."""
        mock_repo = MagicMock(spec=SurrealDBRepository)

        items = [
            ContentMetadata(
                id="content1",
                content_type="youtube",
                title="Video",
                mime_type="text/plain",
                file_size=1000,
                file_path="youtube/content1/transcript.txt",
                created_at=datetime(2025, 1, 1),
            ),
        ]

        mock_repo.list_content = AsyncMock(return_value=(items, 1))
        # get_chunk_counts returns empty dict (no chunks for this content)
        mock_repo.get_chunk_counts = AsyncMock(return_value={})

        result = await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert result.items[0].chunk_count == 0

    @pytest.mark.asyncio
    async def test_chunk_counts_with_mixed_values(self):
        """Test chunk_count mapping with multiple content items having varying counts."""
        mock_repo = MagicMock(spec=SurrealDBRepository)

        items = [
            ContentMetadata(
                id="c1",
                content_type="youtube",
                title="High count",
                mime_type="text/plain",
                file_size=1000,
                file_path="youtube/c1/file.txt",
                created_at=datetime(2025, 1, 1),
            ),
            ContentMetadata(
                id="c2",
                content_type="document",
                title="Zero count",
                mime_type="text/plain",
                file_size=500,
                file_path="document/c2/file.txt",
                created_at=datetime(2025, 1, 2),
            ),
            ContentMetadata(
                id="c3",
                content_type="youtube",
                title="Medium count",
                mime_type="text/plain",
                file_size=750,
                file_path="youtube/c3/file.txt",
                created_at=datetime(2025, 1, 3),
            ),
        ]

        mock_repo.list_content = AsyncMock(return_value=(items, 3))
        mock_repo.get_chunk_counts = AsyncMock(
            return_value={"c1": 100, "c2": 0, "c3": 25}
        )

        result = await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert len(result.items) == 3
        assert result.items[0].chunk_count == 100
        assert result.items[1].chunk_count == 0
        assert result.items[2].chunk_count == 25


class TestContentListOrdering:
    """Tests for deterministic ordering in content list responses."""

    @pytest.mark.asyncio
    async def test_list_content_uses_created_at_desc_ordering(self):
        """Test that list_content passes order_by='created_at DESC' to repo."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 0))
        mock_repo.get_chunk_counts = AsyncMock(return_value={})

        await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        # Verify order_by was passed correctly
        call_kwargs = mock_repo.list_content.call_args.kwargs
        assert call_kwargs["order_by"] == "created_at DESC"

    @pytest.mark.asyncio
    async def test_ordering_preserved_with_filters(self):
        """Test order_by is preserved when filters are applied."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 0))
        mock_repo.get_chunk_counts = AsyncMock(return_value={})

        await list_content(
            key_id="test-key",
            content_type="youtube",
            tags="python,api",
            exclude_tags="test,draft",
            limit=25,
            offset=10,
            surreal_repo=mock_repo,
        )

        call_kwargs = mock_repo.list_content.call_args.kwargs
        assert call_kwargs["order_by"] == "created_at DESC"
        assert call_kwargs["content_type"] == "youtube"
        assert call_kwargs["tags"] == ["python", "api"]
        assert call_kwargs["exclude_tags"] == ["test", "draft"]
        assert call_kwargs["limit"] == 25
        assert call_kwargs["offset"] == 10


class TestContentListResponseShape:
    """Tests for content list response field validation."""

    @pytest.mark.asyncio
    async def test_response_fields_present_and_typed(self):
        """Test all required fields are present with correct types."""
        mock_repo = MagicMock(spec=SurrealDBRepository)

        item = ContentMetadata(
            id="c1",
            content_type="youtube",
            title="Test Video",
            mime_type="text/plain",
            file_size=1000,
            file_path="youtube/c1/transcript.txt",
            created_at=datetime(2025, 2, 15, 10, 30, 0),
            metadata={"custom": "field"},
        )

        mock_repo.list_content = AsyncMock(return_value=([item], 1))
        mock_repo.get_chunk_counts = AsyncMock(return_value={"c1": 5})

        result = await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        response_item = result.items[0]

        # Verify required fields exist
        assert hasattr(response_item, "id")
        assert hasattr(response_item, "content_type")
        assert hasattr(response_item, "created_at")
        assert hasattr(response_item, "chunk_count")

        # Verify types
        assert isinstance(response_item.id, str)
        assert isinstance(response_item.content_type, str)
        assert isinstance(response_item.created_at, str)
        assert isinstance(response_item.chunk_count, int)

        # Verify values
        assert response_item.id == "c1"
        assert response_item.content_type == "youtube"
        assert response_item.created_at == "2025-02-15T10:30:00"
        assert response_item.chunk_count == 5
        assert response_item.title == "Test Video"
        assert response_item.metadata == {"custom": "field"}

    @pytest.mark.asyncio
    async def test_response_chunk_count_defaults_to_zero(self):
        """Test chunk_count defaults to 0 when no chunks exist."""
        mock_repo = MagicMock(spec=SurrealDBRepository)

        item = ContentMetadata(
            id="no-chunks",
            content_type="document",
            title="Empty doc",
            mime_type="text/plain",
            file_size=100,
            file_path="document/no-chunks/file.txt",
            created_at=datetime(2025, 2, 15),
        )

        mock_repo.list_content = AsyncMock(return_value=([item], 1))
        mock_repo.get_chunk_counts = AsyncMock(return_value={})

        result = await list_content(
            key_id="test-key",
            surreal_repo=mock_repo,
        )

        assert result.items[0].chunk_count == 0

    @pytest.mark.asyncio
    async def test_response_pagination_metadata(self):
        """Test response includes correct pagination metadata."""
        mock_repo = MagicMock(spec=SurrealDBRepository)
        mock_repo.list_content = AsyncMock(return_value=([], 100))
        mock_repo.get_chunk_counts = AsyncMock(return_value={})

        result = await list_content(
            key_id="test-key",
            limit=25,
            offset=50,
            surreal_repo=mock_repo,
        )

        assert result.total == 100
        assert result.offset == 50
        assert result.limit == 25
        assert isinstance(result.items, list)
