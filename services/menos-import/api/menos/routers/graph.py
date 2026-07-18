"""Graph data endpoints for visualization."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.models import RelatedContent
from menos.services.di import get_surreal_repo
from menos.services.storage import SurrealDBRepository

router = APIRouter(prefix="/graph", tags=["graph"])
content_router = APIRouter(prefix="/content", tags=["graph"])


class GraphNode(BaseModel):
    """Node in the graph."""

    id: str
    title: str | None = None
    content_type: str
    tags: list[str] = []
    processing_status: str | None = None


class GraphEdge(BaseModel):
    """Edge in the graph."""

    source: str
    target: str | None = None
    link_type: str
    link_text: str


class GraphData(BaseModel):
    """Graph data for visualization."""

    nodes: list[GraphNode]
    edges: list[GraphEdge]


@router.get("", response_model=GraphData)
async def get_graph(
    key_id: AuthenticatedKeyId,
    tags: Annotated[
        str | None, Query(description="Filter by tags (comma-separated, must have ALL)")
    ] = None,
    content_type: Annotated[str | None, Query(description="Filter by content type")] = None,
    limit: Annotated[int, Query(ge=1, le=1000)] = 500,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get graph data for visualization.

    Returns nodes and edges for graph visualization tools like D3.js, Cytoscape, etc.
    By default, returns up to 500 nodes and their links.
    """
    tags_list = [t.strip() for t in tags.split(",")] if tags else None

    nodes_data, edges_data = await surreal_repo.get_graph_data(
        tags=tags_list,
        content_type=content_type,
        limit=limit,
    )

    nodes = [
        GraphNode(
            id=node.id or "",
            title=node.title,
            content_type=node.content_type,
            tags=node.tags or [],
            processing_status=getattr(node, "processing_status", None),
        )
        for node in nodes_data
    ]

    edges = [
        GraphEdge(
            source=edge.source,
            target=edge.target,
            link_type=edge.link_type,
            link_text=edge.link_text,
        )
        for edge in edges_data
    ]

    return GraphData(nodes=nodes, edges=edges)


@router.get("/neighborhood/{id}", response_model=GraphData)
async def get_neighborhood(
    id: str,
    key_id: AuthenticatedKeyId,
    depth: Annotated[int, Query(ge=1, le=3)] = 1,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get neighborhood graph around a specific content item.

    Returns nodes within N hops of the center node, including both forward links
    and backlinks. Useful for exploring local connections around a document.

    Args:
        id: Center node content ID
        depth: Number of hops to traverse (1-3, default 1)

    Returns:
        Graph data with nodes and edges in the neighborhood

    Raises:
        404: If center node doesn't exist
    """
    nodes_data, edges_data = await surreal_repo.get_neighborhood(
        content_id=id,
        depth=depth,
    )

    # Return 404 if center node doesn't exist (empty result)
    if not nodes_data:
        raise HTTPException(status_code=404, detail=f"Content {id} not found")

    nodes = [
        GraphNode(
            id=node.id or "",
            title=node.title,
            content_type=node.content_type,
            tags=node.tags or [],
            processing_status=getattr(node, "processing_status", None),
        )
        for node in nodes_data
    ]

    edges = [
        GraphEdge(
            source=edge.source,
            target=edge.target,
            link_type=edge.link_type,
            link_text=edge.link_text,
        )
        for edge in edges_data
    ]

    return GraphData(nodes=nodes, edges=edges)


@content_router.get("/{content_id}/related", response_model=list[RelatedContent])
async def get_related_content(
    content_id: str,
    key_id: AuthenticatedKeyId,
    limit: Annotated[int, Query(ge=1, le=50)] = 10,
    window: Annotated[
        str,
        Query(pattern=r"^(0|\d+[mwd])$", description="0 or duration like 12m, 2w, 30d"),
    ] = "12m",
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get content related by shared entities."""
    content = await surreal_repo.get_content(content_id)
    if not content:
        raise HTTPException(status_code=404, detail="Content not found")

    return await surreal_repo.get_related_content(content_id=content_id, limit=limit, window=window)
