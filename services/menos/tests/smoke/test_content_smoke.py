"""Smoke tests for content endpoints."""

import pytest


@pytest.mark.smoke
class TestContentSmoke:
    """Smoke tests for content endpoints."""

    def test_content_list_requires_auth(self, smoke_http_client):
        """GET /api/v1/content without auth returns 401."""
        response = smoke_http_client.get("/api/v1/content")
        assert response.status_code == 401

    def test_content_list_returns_paginated(self, smoke_authed_get):
        """GET /api/v1/content returns paginated response structure."""
        response = smoke_authed_get("/api/v1/content")
        assert response.status_code == 200

        data = response.json()
        assert "items" in data
        assert isinstance(data["items"], list)
        assert "total" in data
        assert isinstance(data["total"], int)
        assert "offset" in data
        assert isinstance(data["offset"], int)
        assert "limit" in data
        assert isinstance(data["limit"], int)

    def test_content_list_item_structure(self, smoke_authed_get):
        """Content list items have required fields."""
        response = smoke_authed_get("/api/v1/content")
        assert response.status_code == 200

        data = response.json()
        items = data.get("items", [])

        if items:
            first = items[0]
            assert "id" in first
            assert isinstance(first["id"], str)
            assert "content_type" in first
            assert isinstance(first["content_type"], str)
            assert "created_at" in first
            assert isinstance(first["created_at"], str)

    def test_content_get_by_id(self, smoke_authed_get, smoke_first_content_id):
        """GET /api/v1/content/{id} returns content metadata."""
        response = smoke_authed_get(f"/api/v1/content/{smoke_first_content_id}")
        assert response.status_code == 200

        data = response.json()
        assert "id" in data
        assert isinstance(data["id"], str)
        assert "content_type" in data
        assert isinstance(data["content_type"], str)

    def test_content_links(self, smoke_authed_get, smoke_first_content_id):
        """GET /api/v1/content/{id}/links returns links list."""
        response = smoke_authed_get(f"/api/v1/content/{smoke_first_content_id}/links")
        assert response.status_code == 200

        data = response.json()
        assert "links" in data
        assert isinstance(data["links"], list)

    def test_content_backlinks(self, smoke_authed_get, smoke_first_content_id):
        """GET /api/v1/content/{id}/backlinks returns links list."""
        response = smoke_authed_get(f"/api/v1/content/{smoke_first_content_id}/backlinks")
        assert response.status_code == 200

        data = response.json()
        assert "links" in data
        assert isinstance(data["links"], list)

    def test_tags_list(self, smoke_authed_get):
        """GET /api/v1/content/tags returns tags list."""
        response = smoke_authed_get("/api/v1/content/tags")
        assert response.status_code == 200

        data = response.json()
        assert "tags" in data
        assert isinstance(data["tags"], list)

    def test_tags_item_structure(self, smoke_authed_get):
        """Tag items have name and count fields."""
        response = smoke_authed_get("/api/v1/content/tags")
        assert response.status_code == 200

        data = response.json()
        tags = data.get("tags", [])

        if tags:
            first = tags[0]
            assert "name" in first
            assert isinstance(first["name"], str)
            assert "count" in first
            assert isinstance(first["count"], int)
            assert first["count"] > 0
