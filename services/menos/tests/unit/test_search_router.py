"""Unit tests for search router tier filtering."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from menos.routers.search import AgenticSearchQuery, SearchQuery, agentic_search, vector_search
from menos.services.agent import AgentSearchResult


class TestSearchQueryTierValidation:
    """Tests for SearchQuery tier_min validation and normalization."""

    def test_search_query_normalizes_tier_min(self):
        body = SearchQuery(query="test", tier_min=" b ")
        assert body.tier_min == "B"

    def test_search_query_rejects_invalid_tier_min(self):
        with pytest.raises(ValidationError, match="tier_min must be one of S, A, B, C, D"):
            SearchQuery(query="test", tier_min="X")

    def test_agentic_query_normalizes_tier_min(self):
        body = AgenticSearchQuery(query="test", tier_min="a")
        assert body.tier_min == "A"

    def test_agentic_query_rejects_invalid_tier_min(self):
        with pytest.raises(ValidationError, match="tier_min must be one of S, A, B, C, D"):
            AgenticSearchQuery(query="test", tier_min="bad")


class TestSearchRouterFilterPropagation:
    """Tests for tier filter propagation through router handlers."""

    @pytest.mark.asyncio
    async def test_vector_search_uses_tier_filter_and_tags_contains_any(self):
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 4)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(query="test", tags=["python"], tier_min="b", limit=5)

        response = await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        assert response.total == 0
        query_str, params = surreal_repo.db.query.call_args[0]
        assert "content_id.tags CONTAINSANY $tags" in query_str
        assert "content_id.tier IN $valid_tiers" in query_str
        assert params["tags"] == ["python"]
        assert params["valid_tiers"] == ["S", "A", "B"]

    @pytest.mark.asyncio
    async def test_agentic_search_passes_normalized_tier_min(self):
        agent_service = MagicMock()
        agent_service.search = AsyncMock(
            return_value=AgentSearchResult(
                answer="ok",
                sources=[],
                timing={
                    "expansion_ms": 1,
                    "retrieval_ms": 1,
                    "rerank_ms": 1,
                    "synthesis_ms": 1,
                    "total_ms": 4,
                },
            )
        )

        body = AgenticSearchQuery(query="test", tier_min="c")
        response = await agentic_search(
            body=body,
            key_id="test-key",
            agent_service=agent_service,
        )

        assert response.query == "test"
        agent_service.search.assert_called_once_with(
            query="test",
            content_type=None,
            tier_min="C",
            limit=10,
        )


class TestSearchExcludeTagsAndEmbeddingGuards:
    """Tests for exclude_tags default behavior and NONE embedding guard."""

    @pytest.mark.asyncio
    async def test_omitted_exclude_tags_defaults_to_test(self):
        """Test that omitted exclude_tags produces CONTAINSNONE with ['test']."""
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(query="semantic search", limit=10)

        await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        query_str, params = surreal_repo.db.query.call_args[0]
        assert "content_id.tags CONTAINSNONE $exclude_tags" in query_str
        assert params["exclude_tags"] == ["test"]

    @pytest.mark.asyncio
    async def test_tags_include_test_removes_test_from_exclusions(self):
        """Test that tags=['test'] removes 'test' from effective exclusion list."""
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(query="test content", tags=["test"], limit=10)

        await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        query_str, params = surreal_repo.db.query.call_args[0]
        # When tags includes "test", the default ["test"] exclusion is removed
        assert "content_id.tags CONTAINSNONE $exclude_tags" not in query_str
        assert "exclude_tags" not in params
        # But tags CONTAINSANY should still be present
        assert "content_id.tags CONTAINSANY $tags" in query_str
        assert params["tags"] == ["test"]

    @pytest.mark.asyncio
    async def test_empty_exclude_tags_disables_containsnone_clause(self):
        """Test that exclude_tags=[] omits CONTAINSNONE clause entirely."""
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(query="all content", exclude_tags=[], limit=10)

        await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        query_str, params = surreal_repo.db.query.call_args[0]
        # Empty exclude_tags should disable the filter
        assert "CONTAINSNONE" not in query_str
        assert "exclude_tags" not in params

    @pytest.mark.asyncio
    async def test_query_contains_embedding_not_none_guard(self):
        """Test that query string contains embedding != NONE guard."""
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(query="test query", limit=10)

        await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        query_str, _ = surreal_repo.db.query.call_args[0]
        # Must have embedding != NONE to prevent cosine similarity errors
        assert "WHERE embedding != NONE" in query_str
        # Verify the WHERE clause structure includes the guard
        assert "WHERE embedding != NONE AND vector::similarity::cosine" in query_str

    @pytest.mark.asyncio
    async def test_explicit_exclude_tags_with_multiple_values(self):
        """Test explicit exclude_tags with multiple values."""
        embedding_service = MagicMock()
        embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)

        surreal_repo = MagicMock()
        surreal_repo.db = MagicMock()
        surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        body = SearchQuery(
            query="production content",
            exclude_tags=["test", "draft", "archived"],
            limit=10,
        )

        await vector_search(
            body=body,
            key_id="test-key",
            embedding_service=embedding_service,
            surreal_repo=surreal_repo,
        )

        query_str, params = surreal_repo.db.query.call_args[0]
        assert "content_id.tags CONTAINSNONE $exclude_tags" in query_str
        assert params["exclude_tags"] == ["test", "draft", "archived"]
