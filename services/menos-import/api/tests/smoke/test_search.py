"""Smoke tests for search endpoints."""

import json
from urllib.parse import urlparse

import pytest


@pytest.mark.smoke
class TestSearchSmoke:
    """Smoke tests for vector search endpoints."""

    def test_search_requires_auth(self, smoke_http_client):
        """POST /api/v1/search returns 401 without auth."""
        payload = {"query": "test query", "limit": 5}
        response = smoke_http_client.post(
            "/api/v1/search",
            json=payload
        )
        assert response.status_code == 401

    def test_search_returns_results(
        self, smoke_http_client, smoke_base_url, smoke_authed_headers
    ):
        """POST /api/v1/search with auth returns 200 and proper structure."""
        host = urlparse(smoke_base_url).netloc
        path = "/api/v1/search"
        payload = {"query": "test", "limit": 5}
        body = json.dumps(payload).encode()

        headers = smoke_authed_headers("POST", path, body=body, host=host)
        headers["content-type"] = "application/json"

        response = smoke_http_client.post(path, content=body, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert "total" in data

    def test_search_response_structure(
        self, smoke_http_client, smoke_base_url, smoke_authed_headers
    ):
        """Verify response has query, results (list), total fields."""
        host = urlparse(smoke_base_url).netloc
        path = "/api/v1/search"
        payload = {"query": "video content", "limit": 10}
        body = json.dumps(payload).encode()

        headers = smoke_authed_headers("POST", path, body=body, host=host)
        headers["content-type"] = "application/json"

        response = smoke_http_client.post(path, content=body, headers=headers)
        assert response.status_code == 200

        data = response.json()
        assert "query" in data
        assert data["query"] == "video content"
        assert "results" in data
        assert isinstance(data["results"], list)
        assert "total" in data
        assert isinstance(data["total"], int)
        assert data["total"] >= 0

    def test_search_result_fields(
        self, smoke_http_client, smoke_base_url, smoke_authed_headers
    ):
        """If results exist, verify each has id, content_type, score."""
        host = urlparse(smoke_base_url).netloc
        path = "/api/v1/search"
        payload = {"query": "test query", "limit": 5}
        body = json.dumps(payload).encode()

        headers = smoke_authed_headers("POST", path, body=body, host=host)
        headers["content-type"] = "application/json"

        response = smoke_http_client.post(path, content=body, headers=headers)
        assert response.status_code == 200

        data = response.json()
        results = data.get("results", [])

        if results:
            for result in results:
                assert "id" in result, "Result missing 'id' field"
                assert isinstance(result["id"], str), "'id' should be string"
                assert len(result["id"]) > 0, "'id' should not be empty"

                assert "content_type" in result, "Result missing 'content_type' field"
                assert isinstance(result["content_type"], str), "'content_type' should be string"

                assert "score" in result, "Result missing 'score' field"
                assert isinstance(result["score"], (int, float)), "'score' should be numeric"
                assert result["score"] >= 0, "'score' should be non-negative"
