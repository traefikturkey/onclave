"""Smoke tests for graph endpoints."""

import pytest


@pytest.mark.smoke
class TestGraphSmoke:
    """Smoke tests for knowledge graph endpoints."""

    def test_graph_requires_auth(self, smoke_http_client):
        """GET /api/v1/graph returns 401 without auth."""
        response = smoke_http_client.get("/api/v1/graph")
        assert response.status_code == 401

    def test_graph_returns_nodes_and_edges(self, smoke_authed_get):
        """GET /api/v1/graph with auth returns nodes and edges lists."""
        response = smoke_authed_get("/api/v1/graph")
        assert response.status_code == 200

        data = response.json()
        assert "nodes" in data
        assert isinstance(data["nodes"], list)
        assert "edges" in data
        assert isinstance(data["edges"], list)

    def test_graph_node_structure(self, smoke_authed_get):
        """If nodes exist, verify structure: id, content_type, tags."""
        response = smoke_authed_get("/api/v1/graph")
        assert response.status_code == 200

        data = response.json()
        nodes = data.get("nodes", [])

        if nodes:
            first_node = nodes[0]
            assert "id" in first_node
            assert isinstance(first_node["id"], str)
            assert "content_type" in first_node
            assert isinstance(first_node["content_type"], str)
            assert "tags" in first_node
            assert isinstance(first_node["tags"], list)

    def test_graph_edge_structure(self, smoke_authed_get):
        """If edges exist, verify structure: source, link_type, link_text."""
        response = smoke_authed_get("/api/v1/graph")
        assert response.status_code == 200

        data = response.json()
        edges = data.get("edges", [])

        if edges:
            first_edge = edges[0]
            assert "source" in first_edge
            assert isinstance(first_edge["source"], str)
            assert "link_type" in first_edge
            assert isinstance(first_edge["link_type"], str)
            assert "link_text" in first_edge
            assert isinstance(first_edge["link_text"], str)

    def test_graph_neighborhood(
        self, smoke_authed_get, smoke_first_content_id
    ):
        """GET /api/v1/graph/neighborhood/{id} returns nodes and edges."""
        path = f"/api/v1/graph/neighborhood/{smoke_first_content_id}"
        response = smoke_authed_get(path)
        assert response.status_code == 200

        data = response.json()
        assert "nodes" in data
        assert isinstance(data["nodes"], list)
        assert "edges" in data
        assert isinstance(data["edges"], list)
