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
        assert "postgres" in data["checks"]
        assert "s3" in data["checks"]
        assert "ollama" in data["checks"]


@pytest.mark.asyncio
async def test_postgres_readiness_checks_and_closes_pool(monkeypatch):
    database = MagicMock()
    monkeypatch.setattr(health, "PostgresDatabase", lambda **_kwargs: database)

    assert await health.check_postgres() == "ok"
    database.open.assert_called_once()
    database.check.assert_called_once()
    database.close.assert_called_once()
