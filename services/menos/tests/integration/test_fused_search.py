"""Integration tests for fused metadata + vector search filters."""

from unittest.mock import AsyncMock, MagicMock

from menos.services.agent import AgentSearchResult, AgentService
from menos.services.di import get_agent_service


class TestVectorSearchFilters:
    """Tests for tier/tags/content_type filter behavior on /search."""

    def test_vector_search_applies_tier_min_filter(
        self, authed_client, mock_surreal_repo, mock_embedding_service
    ):
        mock_embedding_service.embed_query = AsyncMock(return_value=[0.1] * 8)
        mock_surreal_repo.db = MagicMock()
        mock_surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        response = authed_client.post(
            "/api/v1/search",
            json={"query": "test query", "tier_min": "b", "limit": 5},
        )

        assert response.status_code == 200
        query_str, params = mock_surreal_repo.db.query.call_args[0]
        assert "content_id.tier IN $valid_tiers" in query_str
        assert params["valid_tiers"] == ["S", "A", "B"]

    def test_vector_search_combines_tier_tags_and_content_type(
        self, authed_client, mock_surreal_repo, mock_embedding_service
    ):
        mock_embedding_service.embed_query = AsyncMock(return_value=[0.1] * 8)
        mock_surreal_repo.db = MagicMock()
        mock_surreal_repo.db.query = MagicMock(return_value=[{"result": []}])

        response = authed_client.post(
            "/api/v1/search",
            json={
                "query": "test query",
                "tier_min": "A",
                "tags": ["python", "llm"],
                "content_type": "youtube",
                "limit": 5,
            },
        )

        assert response.status_code == 200
        query_str, params = mock_surreal_repo.db.query.call_args[0]
        assert "content_id.tags CONTAINSANY $tags" in query_str
        assert "content_id.content_type = $content_type" in query_str
        assert "content_id.tier IN $valid_tiers" in query_str
        assert params["tags"] == ["python", "llm"]
        assert params["content_type"] == "youtube"
        assert params["valid_tiers"] == ["S", "A"]

    def test_vector_search_rejects_invalid_tier_min(self, authed_client):
        response = authed_client.post(
            "/api/v1/search",
            json={"query": "test query", "tier_min": "Z"},
        )

        assert response.status_code == 422
        assert "tier_min must be one of S, A, B, C, D" in response.text


class TestAgenticSearchFilters:
    """Tests for tier filter passthrough on /search/agentic."""

    def test_agentic_search_passes_tier_min_to_service(self, authed_client, app_with_keys):
        mock_agent_service = MagicMock(spec=AgentService)
        mock_agent_service.search = AsyncMock(
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
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test", "tier_min": "c"},
        )

        assert response.status_code == 200
        mock_agent_service.search.assert_called_once_with(
            query="test",
            content_type=None,
            tier_min="C",
            limit=10,
        )

    def test_agentic_search_rejects_invalid_tier_min(self, authed_client):
        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test", "tier_min": "invalid"},
        )

        assert response.status_code == 422
        assert "tier_min must be one of S, A, B, C, D" in response.text
