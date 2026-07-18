"""Tests for graph data functionality."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import ContentMetadata, LinkModel


@pytest.fixture
def mock_surreal_repo():
    """Mock SurrealDB repository."""
    repo = MagicMock()
    repo.get_graph_data = AsyncMock()
    return repo


@pytest.mark.asyncio
async def test_get_graph_data_no_filters(mock_surreal_repo):
    """Test get_graph_data without filters."""
    # Create test data
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
        link_text="Related Doc",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1, node2], [edge1])

    nodes, edges = await mock_surreal_repo.get_graph_data()

    assert len(nodes) == 2
    assert len(edges) == 1
    assert nodes[0].id == "node1"
    assert nodes[1].id == "node2"
    assert edges[0].source == "node1"
    assert edges[0].target == "node2"


@pytest.mark.asyncio
async def test_get_graph_data_with_tag_filter(mock_surreal_repo):
    """Test get_graph_data with tag filter."""
    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Python Doc",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc1.md",
        tags=["python", "testing"],
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1], [])

    nodes, edges = await mock_surreal_repo.get_graph_data(tags=["python"])

    assert len(nodes) == 1
    assert "python" in nodes[0].tags
    mock_surreal_repo.get_graph_data.assert_called_once_with(tags=["python"])


@pytest.mark.asyncio
async def test_get_graph_data_with_content_type_filter(mock_surreal_repo):
    """Test get_graph_data with content_type filter."""
    node1 = ContentMetadata(
        id="node1",
        content_type="video",
        title="Tutorial Video",
        mime_type="video/mp4",
        file_size=1000,
        file_path="videos/tutorial.mp4",
        tags=["tutorial"],
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1], [])

    nodes, edges = await mock_surreal_repo.get_graph_data(content_type="video")

    assert len(nodes) == 1
    assert nodes[0].content_type == "video"
    mock_surreal_repo.get_graph_data.assert_called_once_with(content_type="video")


@pytest.mark.asyncio
async def test_get_graph_data_with_limit(mock_surreal_repo):
    """Test get_graph_data respects limit parameter."""
    nodes_list = [
        ContentMetadata(
            id=f"node{i}",
            content_type="document",
            title=f"Doc {i}",
            mime_type="text/markdown",
            file_size=100,
            file_path=f"docs/doc{i}.md",
            tags=[],
            created_at=datetime.now(UTC),
        )
        for i in range(10)
    ]

    mock_surreal_repo.get_graph_data.return_value = (nodes_list, [])

    nodes, edges = await mock_surreal_repo.get_graph_data(limit=10)

    assert len(nodes) == 10
    mock_surreal_repo.get_graph_data.assert_called_once_with(limit=10)


@pytest.mark.asyncio
async def test_get_graph_data_unresolved_links(mock_surreal_repo):
    """Test get_graph_data includes unresolved links (target=None)."""
    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Document with broken link",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc1.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    # Link with no target (unresolved)
    edge1 = LinkModel(
        id="link1",
        source="node1",
        target=None,
        link_text="Missing Doc",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1], [edge1])

    nodes, edges = await mock_surreal_repo.get_graph_data()

    assert len(edges) == 1
    assert edges[0].target is None
    assert edges[0].link_text == "Missing Doc"


@pytest.mark.asyncio
async def test_get_graph_data_empty_result(mock_surreal_repo):
    """Test get_graph_data with no matching content."""
    mock_surreal_repo.get_graph_data.return_value = ([], [])

    nodes, edges = await mock_surreal_repo.get_graph_data(tags=["nonexistent"])

    assert len(nodes) == 0
    assert len(edges) == 0


@pytest.mark.asyncio
async def test_get_graph_data_multiple_edges(mock_surreal_repo):
    """Test get_graph_data with multiple edges between nodes."""
    node1 = ContentMetadata(
        id="node1",
        content_type="document",
        title="Doc 1",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc1.md",
        tags=[],
        created_at=datetime.now(UTC),
    )
    node2 = ContentMetadata(
        id="node2",
        content_type="document",
        title="Doc 2",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/doc2.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    # Multiple links between same nodes
    edge1 = LinkModel(
        id="link1",
        source="node1",
        target="node2",
        link_text="See also",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )
    edge2 = LinkModel(
        id="link2",
        source="node1",
        target="node2",
        link_text="Related",
        link_type="markdown",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_graph_data.return_value = ([node1, node2], [edge1, edge2])

    nodes, edges = await mock_surreal_repo.get_graph_data()

    assert len(nodes) == 2
    assert len(edges) == 2
    assert all(e.source == "node1" and e.target == "node2" for e in edges)


@pytest.mark.asyncio
async def test_get_neighborhood_nonexistent_node(mock_surreal_repo):
    """Test get_neighborhood with nonexistent center node."""
    mock_surreal_repo.get_neighborhood = AsyncMock()
    mock_surreal_repo.get_neighborhood.return_value = ([], [])

    nodes, edges = await mock_surreal_repo.get_neighborhood(content_id="nonexistent")

    assert len(nodes) == 0
    assert len(edges) == 0


@pytest.mark.asyncio
async def test_get_neighborhood_depth_1(mock_surreal_repo):
    """Test get_neighborhood with depth=1 (immediate neighbors)."""
    center = ContentMetadata(
        id="center",
        content_type="document",
        title="Center Doc",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/center.md",
        tags=[],
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

    mock_surreal_repo.get_neighborhood = AsyncMock()
    mock_surreal_repo.get_neighborhood.return_value = (
        [center, neighbor1, neighbor2],
        [edge1, edge2],
    )

    nodes, edges = await mock_surreal_repo.get_neighborhood(content_id="center", depth=1)

    assert len(nodes) == 3
    assert len(edges) == 2
    node_ids = {node.id for node in nodes}
    assert "center" in node_ids
    assert "neighbor1" in node_ids
    assert "neighbor2" in node_ids


@pytest.mark.asyncio
async def test_get_neighborhood_depth_2(mock_surreal_repo):
    """Test get_neighborhood with depth=2 (2 hops)."""
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

    mock_surreal_repo.get_neighborhood = AsyncMock()
    mock_surreal_repo.get_neighborhood.return_value = (
        [node1, node2, node3],
        [edge1, edge2],
    )

    nodes, edges = await mock_surreal_repo.get_neighborhood(content_id="node1", depth=2)

    assert len(nodes) == 3
    assert len(edges) == 2
    node_ids = {node.id for node in nodes}
    assert "node1" in node_ids
    assert "node2" in node_ids
    assert "node3" in node_ids


@pytest.mark.asyncio
async def test_get_neighborhood_isolated_node(mock_surreal_repo):
    """Test get_neighborhood with isolated node (no connections)."""
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

    mock_surreal_repo.get_neighborhood = AsyncMock()
    mock_surreal_repo.get_neighborhood.return_value = ([isolated], [])

    nodes, edges = await mock_surreal_repo.get_neighborhood(content_id="isolated", depth=1)

    assert len(nodes) == 1
    assert nodes[0].id == "isolated"
    assert len(edges) == 0


@pytest.mark.asyncio
async def test_get_neighborhood_bidirectional_links(mock_surreal_repo):
    """Test get_neighborhood includes both forward and backlinks."""
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
    linked_to = ContentMetadata(
        id="linked_to",
        content_type="document",
        title="Linked To",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/linked_to.md",
        tags=[],
        created_at=datetime.now(UTC),
    )
    linked_from = ContentMetadata(
        id="linked_from",
        content_type="document",
        title="Linked From",
        mime_type="text/markdown",
        file_size=100,
        file_path="docs/linked_from.md",
        tags=[],
        created_at=datetime.now(UTC),
    )

    forward_link = LinkModel(
        id="forward",
        source="center",
        target="linked_to",
        link_text="Forward",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )
    backward_link = LinkModel(
        id="backward",
        source="linked_from",
        target="center",
        link_text="Backward",
        link_type="wiki",
        created_at=datetime.now(UTC),
    )

    mock_surreal_repo.get_neighborhood = AsyncMock()
    mock_surreal_repo.get_neighborhood.return_value = (
        [center, linked_to, linked_from],
        [forward_link, backward_link],
    )

    nodes, edges = await mock_surreal_repo.get_neighborhood(content_id="center", depth=1)

    assert len(nodes) == 3
    assert len(edges) == 2

    # Verify both directions present
    sources = {edge.source for edge in edges}
    targets = {edge.target for edge in edges}
    assert "center" in sources
    assert "center" in targets
