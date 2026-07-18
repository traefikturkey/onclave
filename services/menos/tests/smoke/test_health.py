"""Smoke tests for health endpoints."""

import pytest


@pytest.mark.smoke
class TestHealthSmoke:
    """Health endpoint smoke tests."""

    def test_health_endpoint(self, smoke_http_client):
        """Verify /health returns 200 with ok status."""
        response = smoke_http_client.get("/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"

    def test_ready_endpoint(self, smoke_http_client):
        """Verify /ready returns 200 with status field."""
        response = smoke_http_client.get("/ready")
        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert data["status"] in ("ready", "degraded")

    def test_ready_has_checks(self, smoke_http_client):
        """Verify /ready includes dependency checks."""
        response = smoke_http_client.get("/ready")
        assert response.status_code == 200
        data = response.json()
        assert "checks" in data
        assert isinstance(data["checks"], dict)
        assert "surrealdb" in data["checks"]
        assert "minio" in data["checks"]
        assert "ollama" in data["checks"]
