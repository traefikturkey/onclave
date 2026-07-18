"""Integration tests for agentic search endpoint."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.agent import AgentSearchResult, AgentService
from menos.services.di import get_agent_service


@pytest.fixture
def mock_agent_service():
    """Mock AgentService for testing."""
    service = MagicMock(spec=AgentService)
    service.search = AsyncMock(
        return_value=AgentSearchResult(
            answer="The answer is test [1]",
            sources=[
                {
                    "id": "1",
                    "content_type": "youtube",
                    "title": "Test Video",
                    "score": 0.95,
                    "snippet": "This is test content from the video...",
                }
            ],
            timing={
                "expansion_ms": 100,
                "retrieval_ms": 150,
                "rerank_ms": 50,
                "synthesis_ms": 200,
                "total_ms": 500,
            },
        )
    )
    return service


class TestAgenticSearchRequiresAuth:
    """Tests for authentication requirement on agentic search."""

    def test_agentic_search_requires_auth(self, client):
        """Agentic search should require authentication."""
        response = client.post("/api/v1/search/agentic", json={"query": "test"})

        assert response.status_code == 401
        data = response.json()
        assert "detail" in data

    def test_agentic_search_missing_auth_headers(self, client):
        """Agentic search should reject requests without auth headers."""
        response = client.post(
            "/api/v1/search/agentic",
            json={"query": "test query"},
        )

        assert response.status_code == 401

    def test_agentic_search_invalid_auth(self, client):
        """Agentic search should reject invalid signature."""
        sig_input = 'sig1=("@method" "@path");keyid="fake";alg="ed25519";created=1234567890'
        response = client.post(
            "/api/v1/search/agentic",
            json={"query": "test query"},
            headers={
                "signature-input": sig_input,
                "signature": "sig1=:invalidbase64signature:",
            },
        )

        assert response.status_code == 401


class TestAgenticSearchSuccess:
    """Tests for successful agentic search responses."""

    def test_agentic_search_success_basic(self, authed_client, app_with_keys, mock_agent_service):
        """Test successful agentic search with basic query."""
        # Override dependency with mock
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "What is Python?"},
        )

        assert response.status_code == 200
        data = response.json()

        # Verify response structure
        assert "query" in data
        assert "answer" in data
        assert "sources" in data
        assert "timing" in data

        # Verify content
        assert data["query"] == "What is Python?"
        assert "test" in data["answer"].lower()

        # Verify timing structure
        timing = data["timing"]
        assert "expansion_ms" in timing
        assert "retrieval_ms" in timing
        assert "rerank_ms" in timing
        assert "synthesis_ms" in timing
        assert "total_ms" in timing

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_with_sources(self, authed_client, app_with_keys, mock_agent_service):
        """Test that agentic search returns properly formatted sources."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test query"},
        )

        assert response.status_code == 200
        data = response.json()
        sources = data["sources"]

        assert len(sources) == 1
        source = sources[0]

        # Verify source structure
        assert "id" in source
        assert "content_type" in source
        assert "title" in source
        assert "score" in source
        assert "snippet" in source

        # Verify source content
        assert source["id"] == "1"
        assert source["content_type"] == "youtube"
        assert source["title"] == "Test Video"
        assert source["score"] == 0.95
        assert "test content" in source["snippet"]

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_with_multiple_sources(
        self, authed_client, app_with_keys, mock_agent_service
    ):
        """Test agentic search with multiple source results."""
        # Configure mock to return multiple sources
        multi_source_result = AgentSearchResult(
            answer="Answer with multiple citations [1] and [2]",
            sources=[
                {
                    "id": "1",
                    "content_type": "youtube",
                    "title": "First Video",
                    "score": 0.92,
                    "snippet": "Content from first source...",
                },
                {
                    "id": "2",
                    "content_type": "document",
                    "title": "Second Document",
                    "score": 0.85,
                    "snippet": "Content from second source...",
                },
            ],
            timing={
                "expansion_ms": 100,
                "retrieval_ms": 150,
                "rerank_ms": 50,
                "synthesis_ms": 200,
                "total_ms": 500,
            },
        )
        mock_agent_service.search = AsyncMock(return_value=multi_source_result)
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test multi-source query"},
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["sources"]) == 2
        assert data["sources"][0]["title"] == "First Video"
        assert data["sources"][1]["title"] == "Second Document"

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_with_content_type_filter(
        self, authed_client, app_with_keys, mock_agent_service
    ):
        """Test agentic search with content_type filter parameter."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={
                "query": "test query",
                "content_type": "youtube",
            },
        )

        assert response.status_code == 200
        # Verify the mock was called with the content_type parameter
        mock_agent_service.search.assert_called_once_with(
            query="test query",
            content_type="youtube",
            tier_min=None,
            limit=10,
        )

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_with_limit_parameter(
        self, authed_client, app_with_keys, mock_agent_service
    ):
        """Test agentic search with custom limit parameter."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={
                "query": "test query",
                "limit": 20,
            },
        )

        assert response.status_code == 200
        # Verify the mock was called with the custom limit
        mock_agent_service.search.assert_called_once_with(
            query="test query",
            content_type=None,
            tier_min=None,
            limit=20,
        )

        # Cleanup
        app_with_keys.dependency_overrides.clear()


class TestAgenticSearchTiming:
    """Tests for timing information in agentic search responses."""

    def test_agentic_search_timing_response(self, authed_client, app_with_keys, mock_agent_service):
        """Verify timing info is returned and properly formatted."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test timing"},
        )

        assert response.status_code == 200
        data = response.json()
        timing = data["timing"]

        # Verify all timing components are present
        assert isinstance(timing["expansion_ms"], (int, float))
        assert isinstance(timing["retrieval_ms"], (int, float))
        assert isinstance(timing["rerank_ms"], (int, float))
        assert isinstance(timing["synthesis_ms"], (int, float))
        assert isinstance(timing["total_ms"], (int, float))

        # Verify timing values are non-negative
        assert timing["expansion_ms"] >= 0
        assert timing["retrieval_ms"] >= 0
        assert timing["rerank_ms"] >= 0
        assert timing["synthesis_ms"] >= 0
        assert timing["total_ms"] >= 0

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_timing_total_accumulation(
        self, authed_client, app_with_keys, mock_agent_service
    ):
        """Verify total timing is greater than or equal to sum of stages."""
        # Set specific timing values
        timed_result = AgentSearchResult(
            answer="Test answer [1]",
            sources=[
                {
                    "id": "1",
                    "content_type": "test",
                    "title": "Test",
                    "score": 0.9,
                    "snippet": "snippet",
                }
            ],
            timing={
                "expansion_ms": 100,
                "retrieval_ms": 200,
                "rerank_ms": 50,
                "synthesis_ms": 150,
                "total_ms": 500,
            },
        )
        mock_agent_service.search = AsyncMock(return_value=timed_result)
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test"},
        )

        assert response.status_code == 200
        timing = response.json()["timing"]

        # Total should be >= sum of individual stages
        sum_of_stages = (
            timing["expansion_ms"]
            + timing["retrieval_ms"]
            + timing["rerank_ms"]
            + timing["synthesis_ms"]
        )
        assert timing["total_ms"] >= sum_of_stages

        # Cleanup
        app_with_keys.dependency_overrides.clear()


class TestAgenticSearchEdgeCases:
    """Tests for edge cases and error conditions."""

    def test_agentic_search_empty_query(self, authed_client, app_with_keys, mock_agent_service):
        """Test agentic search with empty query string."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": ""},
        )

        # Should still call the service (validation is service's responsibility)
        assert response.status_code == 200
        mock_agent_service.search.assert_called_once_with(
            query="",
            content_type=None,
            tier_min=None,
            limit=10,
        )

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_no_sources(self, authed_client, app_with_keys, mock_agent_service):
        """Test agentic search when no sources are found."""
        empty_result = AgentSearchResult(
            answer="No relevant content found.",
            sources=[],
            timing={
                "expansion_ms": 50,
                "retrieval_ms": 100,
                "rerank_ms": 0,
                "synthesis_ms": 75,
                "total_ms": 225,
            },
        )
        mock_agent_service.search = AsyncMock(return_value=empty_result)
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "obscure query"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["sources"] == []
        # Verify answer reflects no sources found
        assert "relevant content found" in data["answer"].lower()

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_large_limit(self, authed_client, app_with_keys, mock_agent_service):
        """Test agentic search with large limit parameter."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={
                "query": "test",
                "limit": 100,
            },
        )

        assert response.status_code == 200
        mock_agent_service.search.assert_called_once_with(
            query="test",
            content_type=None,
            tier_min=None,
            limit=100,
        )

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_special_characters_in_query(
        self, authed_client, app_with_keys, mock_agent_service
    ):
        """Test agentic search with special characters in query."""
        special_query = "What is @#$%^&*() in Python?"
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": special_query},
        )

        assert response.status_code == 200
        mock_agent_service.search.assert_called_once_with(
            query=special_query,
            content_type=None,
            tier_min=None,
            limit=10,
        )

        # Cleanup
        app_with_keys.dependency_overrides.clear()


class TestAgenticSearchResponseValidation:
    """Tests for response schema validation."""

    def test_agentic_search_response_schema(self, authed_client, app_with_keys, mock_agent_service):
        """Verify response matches AgenticSearchResponse schema."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test"},
        )

        assert response.status_code == 200
        data = response.json()

        # Root level fields
        assert isinstance(data["query"], str)
        assert isinstance(data["answer"], str)
        assert isinstance(data["sources"], list)
        assert isinstance(data["timing"], dict)

        # Source fields
        for source in data["sources"]:
            assert isinstance(source["id"], str)
            assert isinstance(source["content_type"], str)
            assert isinstance(source["title"], (str, type(None)))
            assert isinstance(source["score"], (int, float))
            assert isinstance(source["snippet"], (str, type(None)))

        # Cleanup
        app_with_keys.dependency_overrides.clear()

    def test_agentic_search_timing_fields(self, authed_client, app_with_keys, mock_agent_service):
        """Verify timing object has all required fields."""
        app_with_keys.dependency_overrides[get_agent_service] = lambda: mock_agent_service

        response = authed_client.post(
            "/api/v1/search/agentic",
            json={"query": "test"},
        )

        assert response.status_code == 200
        timing = response.json()["timing"]

        required_fields = ["expansion_ms", "retrieval_ms", "rerank_ms", "synthesis_ms", "total_ms"]
        for field in required_fields:
            assert field in timing

        # Cleanup
        app_with_keys.dependency_overrides.clear()
