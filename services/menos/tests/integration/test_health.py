"""Integration tests for health endpoints."""

from unittest.mock import MagicMock

import pytest

from menos.routers import health


class TestHealthEndpoints:
    """Tests for health check endpoints."""

    def test_health_returns_ok(self, client):
        """Health endpoint should return ok."""
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "git_sha" in data
        assert "build_date" in data

    def test_ready_returns_status(self, client):
        """Ready endpoint should return service status."""
        response = client.get("/ready")

        assert response.status_code == 200
        data = response.json()
        assert "status" in data
        assert "checks" in data
        assert "surrealdb" in data["checks"]
        assert "s3" in data["checks"]
        assert "ollama" in data["checks"]


@pytest.mark.asyncio
async def test_surrealdb_readiness_does_not_close_blocking_http_client(monkeypatch):
    """The blocking HTTP client has no close implementation."""
    db = MagicMock()
    db.close.side_effect = Exception("close not implemented for blocking HTTP client")
    monkeypatch.setattr(health, "Surreal", lambda _url: db)

    assert await health.check_surrealdb() == "ok"
    db.signin.assert_called_once()
    db.use.assert_called_once()
    db.query.assert_called_once_with("INFO FOR DB")
    db.close.assert_not_called()
