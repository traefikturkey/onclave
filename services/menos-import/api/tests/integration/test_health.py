"""Integration tests for health endpoints."""


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
