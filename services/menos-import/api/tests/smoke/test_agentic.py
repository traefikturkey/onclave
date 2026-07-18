"""Smoke tests for agentic search endpoint."""

import json
from urllib.parse import urlparse

import httpx
import pytest


@pytest.fixture(scope="session")
def smoke_http_client_long_timeout(smoke_base_url):
    """Create httpx client with extended timeout for agentic search.

    With 45K chunks and no HNSW index, agentic search (multiple vector scans +
    LLM expansion + LLM synthesis) can take 3+ minutes.
    """
    with httpx.Client(base_url=smoke_base_url, timeout=300.0) as client:
        yield client


@pytest.fixture(scope="session")
def smoke_agentic_result(
    smoke_http_client_long_timeout, smoke_base_url, smoke_authed_headers
):
    """Execute a single agentic search and share the result across tests.

    Agentic search is very slow without HNSW (~170s). Making one call and
    reusing the response avoids 5x redundant calls.
    """
    path = "/api/v1/search/agentic"
    payload = {"query": "what topics are discussed?", "limit": 5}
    body = json.dumps(payload).encode()

    host = urlparse(smoke_base_url).netloc
    headers = smoke_authed_headers("POST", path, body=body, host=host)
    headers["content-type"] = "application/json"

    response = smoke_http_client_long_timeout.post(
        path, content=body, headers=headers
    )

    assert response.status_code == 200, (
        f"Agentic search failed: {response.status_code} {response.text}"
    )
    return {"query": payload["query"], "data": response.json()}


@pytest.mark.smoke
class TestAgenticSearchSmoke:
    """Smoke tests for agentic search endpoint."""

    def test_agentic_search_requires_auth(self, smoke_http_client):
        """POST /api/v1/search/agentic returns 401 without auth."""
        response = smoke_http_client.post(
            "/api/v1/search/agentic",
            json={"query": "what topics are discussed?", "limit": 5},
        )

        assert response.status_code == 401
        data = response.json()
        assert "detail" in data

    def test_agentic_search_returns_response(self, smoke_agentic_result):
        """With auth, returns answer, sources, timing."""
        data = smoke_agentic_result["data"]
        query = smoke_agentic_result["query"]

        assert "query" in data
        assert "answer" in data
        assert "sources" in data
        assert "timing" in data

        assert data["query"] == query
        assert isinstance(data["answer"], str)
        assert len(data["answer"]) > 0
        assert isinstance(data["sources"], list)
        assert isinstance(data["timing"], dict)

    def test_agentic_search_timing_structure(self, smoke_agentic_result):
        """Verify timing has all required fields."""
        timing = smoke_agentic_result["data"]["timing"]

        required_timing_fields = [
            "expansion_ms",
            "retrieval_ms",
            "rerank_ms",
            "synthesis_ms",
            "total_ms",
        ]
        for field in required_timing_fields:
            assert field in timing, f"Missing timing field: {field}"
            assert isinstance(
                timing[field], (int, float)
            ), f"{field} should be numeric, got {type(timing[field])}"

    def test_agentic_search_timing_reasonable(self, smoke_agentic_result):
        """Assert timing.total_ms < 300s (allowing for no HNSW index)."""
        timing = smoke_agentic_result["data"]["timing"]

        # With 45K+ chunks and no HNSW index, vector search can be slow (~170s).
        # Once HNSW indexing is added, reduce this threshold to 30000ms.
        assert (
            timing["total_ms"] < 300000
        ), f"Agentic search took {timing['total_ms']}ms, exceeds 300s threshold"

        assert timing["total_ms"] >= 0
        assert timing["expansion_ms"] >= 0
        assert timing["retrieval_ms"] >= 0
        assert timing["rerank_ms"] >= 0
        assert timing["synthesis_ms"] >= 0

    def test_agentic_search_sources_structure(self, smoke_agentic_result):
        """If sources exist, verify each has id, content_type, score."""
        sources = smoke_agentic_result["data"]["sources"]

        if sources:
            for source in sources:
                assert "id" in source, "Source missing id field"
                assert "content_type" in source, "Source missing content_type"
                assert "score" in source, "Source missing score field"

                assert isinstance(source["id"], str)
                assert isinstance(source["content_type"], str)
                assert isinstance(source["score"], (int, float))

                if "title" in source:
                    assert isinstance(source["title"], (str, type(None)))
                if "snippet" in source:
                    assert isinstance(source["snippet"], (str, type(None)))

                assert (
                    0 <= source["score"] <= 1
                ), f"Score {source['score']} outside [0,1] range"
