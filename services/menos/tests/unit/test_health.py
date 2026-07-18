"""Unit tests for health endpoint."""

import re

from fastapi.testclient import TestClient

from menos.main import app


class TestHealthEndpoint:
    """Tests for /health endpoint version metadata."""

    def test_health_returns_expected_keys(self):
        """Health endpoint should return status, git_sha, build_date, and app_version."""
        client = TestClient(app)
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "git_sha" in data
        assert "build_date" in data
        assert "app_version" in data

    def test_health_returns_git_sha_from_env(self, monkeypatch):
        """Health endpoint should return GIT_SHA from environment."""
        monkeypatch.setenv("GIT_SHA", "abc123def456")
        client = TestClient(app)
        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["git_sha"] == "abc123def456"

    def test_health_returns_unknown_when_no_env(self, monkeypatch):
        """Health endpoint should return 'unknown' when GIT_SHA is not set."""
        monkeypatch.delenv("GIT_SHA", raising=False)
        client = TestClient(app)
        response = client.get("/health")

        assert response.status_code == 200
        assert response.json()["git_sha"] == "unknown"

    def test_health_returns_app_version(self):
        """Health endpoint should return app_version as a valid semver string."""
        client = TestClient(app)
        response = client.get("/health")

        assert response.status_code == 200
        data = response.json()
        assert "app_version" in data
        assert re.match(r"\d+\.\d+\.\d+", data["app_version"])
