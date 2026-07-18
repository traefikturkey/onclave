"""Smoke tests for auth endpoints."""

from urllib.parse import urlparse

import pytest


@pytest.mark.smoke
class TestAuthSmoke:
    """Smoke tests for authentication endpoints."""

    def test_list_keys_public(self, smoke_http_client):
        """GET /api/v1/auth/keys returns 200 (no auth needed)."""
        response = smoke_http_client.get("/api/v1/auth/keys")
        assert response.status_code == 200

        data = response.json()
        assert "keys" in data
        assert isinstance(data["keys"], list)

    def test_whoami_requires_auth(self, smoke_http_client):
        """GET /api/v1/auth/whoami returns 401 without auth."""
        response = smoke_http_client.get("/api/v1/auth/whoami")
        assert response.status_code == 401

    def test_whoami_with_valid_signature(
        self, smoke_http_client, smoke_base_url, smoke_authed_headers
    ):
        """GET /api/v1/auth/whoami returns 200 with signed request."""
        host = urlparse(smoke_base_url).netloc
        headers = smoke_authed_headers("GET", "/api/v1/auth/whoami", host=host)

        response = smoke_http_client.get("/api/v1/auth/whoami", headers=headers)
        assert response.status_code == 200

        data = response.json()
        assert "key_id" in data
        assert isinstance(data["key_id"], str)
        assert len(data["key_id"]) > 0

    def test_reload_keys_requires_auth(self, smoke_http_client):
        """POST /api/v1/auth/keys/reload returns 401 without auth."""
        response = smoke_http_client.post("/api/v1/auth/keys/reload")
        assert response.status_code == 401

    def test_reload_keys_with_valid_signature(
        self, smoke_http_client, smoke_base_url, smoke_authed_headers
    ):
        """POST /api/v1/auth/keys/reload returns 200 with signed request."""
        host = urlparse(smoke_base_url).netloc
        headers = smoke_authed_headers("POST", "/api/v1/auth/keys/reload", host=host)

        response = smoke_http_client.post("/api/v1/auth/keys/reload", headers=headers)
        assert response.status_code == 200

        data = response.json()
        assert "status" in data
        assert data["status"] == "reloaded"
        assert "keys" in data
        assert isinstance(data["keys"], list)
