"""Smoke tests for entity endpoints."""

import pytest


@pytest.mark.smoke
class TestEntitiesSmoke:
    """Smoke tests for entity endpoints."""

    def test_entities_list_requires_auth(self, smoke_http_client):
        """GET /api/v1/entities returns 401 without auth."""
        response = smoke_http_client.get("/api/v1/entities")
        assert response.status_code == 401

    def test_entities_list_returns_paginated(self, smoke_authed_get):
        """GET /api/v1/entities returns paginated response structure."""
        response = smoke_authed_get("/api/v1/entities")
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

    def test_entities_list_item_structure(self, smoke_authed_get):
        """Entity list items have required fields."""
        response = smoke_authed_get("/api/v1/entities")
        assert response.status_code == 200

        data = response.json()
        items = data.get("items", [])

        if items:
            first = items[0]
            assert "id" in first
            assert isinstance(first["id"], str)
            assert "entity_type" in first
            assert isinstance(first["entity_type"], str)
            assert "name" in first
            assert isinstance(first["name"], str)
            assert "normalized_name" in first
            assert isinstance(first["normalized_name"], str)
            assert "source" in first
            assert isinstance(first["source"], str)

    def test_entities_get_by_id(self, smoke_authed_get, smoke_first_entity_id):
        """GET /api/v1/entities/{entity_id} returns entity details."""
        response = smoke_authed_get(f"/api/v1/entities/{smoke_first_entity_id}")
        assert response.status_code == 200

        data = response.json()
        assert "id" in data
        assert isinstance(data["id"], str)
        assert "entity_type" in data
        assert isinstance(data["entity_type"], str)
        assert "name" in data
        assert isinstance(data["name"], str)

    def test_entities_content(self, smoke_authed_get, smoke_first_entity_id):
        """GET /api/v1/entities/{entity_id}/content returns content list."""
        response = smoke_authed_get(f"/api/v1/entities/{smoke_first_entity_id}/content")
        assert response.status_code == 200

        data = response.json()
        assert "items" in data
        assert isinstance(data["items"], list)
        assert "total" in data
        assert isinstance(data["total"], int)

    def test_entities_topics(self, smoke_authed_get):
        """GET /api/v1/entities/topics returns topics list."""
        response = smoke_authed_get("/api/v1/entities/topics")
        assert response.status_code == 200

        data = response.json()
        assert "topics" in data
        assert isinstance(data["topics"], list)

    def test_entities_duplicates(self, smoke_authed_get):
        """GET /api/v1/entities/duplicates returns duplicate groups."""
        response = smoke_authed_get("/api/v1/entities/duplicates")
        assert response.status_code == 200

        data = response.json()
        assert "groups" in data
        assert isinstance(data["groups"], list)
