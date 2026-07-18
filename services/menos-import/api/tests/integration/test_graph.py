"""Integration tests for graph endpoints."""



def test_get_graph_empty(authed_client):
    """Test GET /api/v1/graph with no content."""
    response = authed_client.get("/api/v1/graph")

    assert response.status_code == 200
    data = response.json()
    assert "nodes" in data
    assert "edges" in data
    assert isinstance(data["nodes"], list)
    assert isinstance(data["edges"], list)


def test_get_graph_requires_auth(client):
    """Test that graph endpoint requires authentication."""
    response = client.get("/api/v1/graph")
    assert response.status_code == 401


def test_get_graph_with_content(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph with some content."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata, LinkModel

    # Setup mock data
    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Document 1",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc1.md",
        tags=["python", "testing"],
        created_at=datetime.now(UTC),
    )
    node2 = ContentMetadata(
        id="node2",
        content_type="document",
        title="Document 2",
        mime_type="text/markdown",
        file_size=200,
        file_path="docs/doc2.md",
        tags=["python"],
        created_at=datetime.now(UTC),
    )
    edge1 = LinkModel(
        id="link1",
        source="node1",
        target="node2",
        link_text="Document 2",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1, node2], [edge1])

    # Get graph
    response = authed_client.get("/api/v1/graph")

    assert response.status_code == 200
    data = response.json()
    assert len(data["nodes"]) == 2
    assert len(data["edges"]) == 1

    # Check node structure
    node_ids = {node["id"] for node in data["nodes"]}
    assert "node1" in node_ids
    assert "node2" in node_ids

    for node in data["nodes"]:
        assert "id" in node
        assert "title" in node
        assert "content_type" in node
        assert "tags" in node
        assert node["content_type"] == "document"

    # Check edge structure
    for edge in data["edges"]:
        assert "source" in edge
        assert "link_type" in edge
        assert "link_text" in edge
        # target can be None for unresolved links


def test_get_graph_unresolved_links(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph includes unresolved links."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata, LinkModel

    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Document",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    # Link with no target (unresolved)
    edge1 = LinkModel(
        id="link1",
        source="node1",
        target=None,
        link_text="Non Existent Doc",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1], [edge1])

    # Get graph
    response = authed_client.get("/api/v1/graph")

    assert response.status_code == 200
    data = response.json()

    # Should have at least one edge with target=None (unresolved)
    unresolved_edges = [edge for edge in data["edges"] if edge["target"] is None]
    assert len(unresolved_edges) == 1
    assert any(edge["link_text"] == "Non Existent Doc" for edge in unresolved_edges)


def test_get_neighborhood_nonexistent_node(authed_client):
    """Test GET /api/v1/graph/neighborhood/{id} with nonexistent node."""
    response = authed_client.get("/api/v1/graph/neighborhood/nonexistent")

    assert response.status_code == 404
    data = response.json()
    assert "not found" in data["detail"].lower()


def test_get_neighborhood_requires_auth(client):
    """Test that neighborhood endpoint requires authentication."""
    response = client.get("/api/v1/graph/neighborhood/test123")
    assert response.status_code == 401


def test_get_neighborhood_depth_1(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph/neighborhood/{id} with depth=1."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata, LinkModel

    center = ContentMetadata(
        id="center",
        content_type="document",
        title="Center Doc",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/center.md",
        tags=["python"],
        created_at=datetime.now(UTC),
    )
    neighbor1 = ContentMetadata(
        id="neighbor1",
        content_type="document",
        title="Neighbor 1",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/neighbor1.md",
        tags=[],
        created_at=datetime.now(UTC),
    )
    neighbor2 = ContentMetadata(
        id="neighbor2",
        content_type="document",
        title="Neighbor 2",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/neighbor2.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    edge1 = LinkModel(
        id="link1",
        source="center",
        target="neighbor1",
        link_text="Related",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )
    edge2 = LinkModel(
        id="link2",
        source="neighbor2",
        target="center",
        link_text="See also",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_neighborhood.return_value = (
        [center, neighbor1, neighbor2],
        [edge1, edge2],
    )

    response = authed_client.get("/api/v1/graph/neighborhood/center", params={"depth": 1})

    assert response.status_code == 200
    data = response.json()

    assert len(data["nodes"]) == 3
    assert len(data["edges"]) == 2

    # Verify center node is included
    node_ids = {node["id"] for node in data["nodes"]}
    assert "center" in node_ids
    assert "neighbor1" in node_ids
    assert "neighbor2" in node_ids

    # Verify edge directions
    sources = {edge["source"] for edge in data["edges"]}
    targets = {edge["target"] for edge in data["edges"]}
    assert "center" in sources
    assert "center" in targets

    # Verify mock was called correctly
    mock_surreal_repo.get_neighborhood.assert_called_once_with(
        content_id="center",
        depth=1,
    )


def test_get_neighborhood_depth_2(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph/neighborhood/{id} with depth=2."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata, LinkModel

    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Node 1",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/node1.md",
        tags=[],
        created_at=datetime.now(UTC),
    )
    node2 = ContentMetadata(
        id="node2",
        content_type="document",
        title="Node 2",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/node2.md",
        tags=[],
        created_at=datetime.now(UTC),
    )
    node3 = ContentMetadata(
        id="node3",
        content_type="document",
        title="Node 3",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/node3.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    edge1 = LinkModel(
        id="link1",
        source="node1",
        target="node2",
        link_text="Link 1-2",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )
    edge2 = LinkModel(
        id="link2",
        source="node2",
        target="node3",
        link_text="Link 2-3",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_neighborhood.return_value = (
        [node1, node2, node3],
        [edge1, edge2],
    )

    response = authed_client.get("/api/v1/graph/neighborhood/node1", params={"depth": 2})

    assert response.status_code == 200
    data = response.json()

    assert len(data["nodes"]) == 3
    assert len(data["edges"]) == 2

    # Verify all nodes in 2-hop path are included
    node_ids = {node["id"] for node in data["nodes"]}
    assert "node1" in node_ids
    assert "node2" in node_ids
    assert "node3" in node_ids

    mock_surreal_repo.get_neighborhood.assert_called_once_with(
        content_id="node1",
        depth=2,
    )


def test_get_neighborhood_default_depth(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph/neighborhood/{id} uses depth=1 by default."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata

    center = ContentMetadata(
        id="center",
        content_type="document",
        title="Center",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/center.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_neighborhood.return_value = ([center], [])

    response = authed_client.get("/api/v1/graph/neighborhood/center")

    assert response.status_code == 200

    # Verify default depth=1 was used
    mock_surreal_repo.get_neighborhood.assert_called_once_with(
        content_id="center",
        depth=1,
    )


def test_get_neighborhood_depth_validation(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph/neighborhood/{id} validates depth parameter."""
    # Test depth < 1
    response = authed_client.get("/api/v1/graph/neighborhood/test", params={"depth": 0})
    assert response.status_code == 422

    # Test depth > 3
    response = authed_client.get("/api/v1/graph/neighborhood/test", params={"depth": 4})
    assert response.status_code == 422


def test_get_neighborhood_isolated_node(authed_client, mock_surreal_repo):
    """Test GET /api/v1/graph/neighborhood/{id} for isolated node."""
    from datetime import UTC, datetime

    from menos.models import ContentMetadata

    isolated = ContentMetadata(
        id="isolated",
        content_type="document",
        title="Isolated Doc",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/isolated.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_neighborhood.return_value = ([isolated], [])

    response = authed_client.get("/api/v1/graph/neighborhood/isolated")

    assert response.status_code == 200
    data = response.json()

    assert len(data["nodes"]) == 1
    assert data["nodes"][0]["id"] == "isolated"
    assert len(data["edges"]) == 0
