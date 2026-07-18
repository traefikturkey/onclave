"""Entity CRUD endpoints."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.models import EntityType
from menos.services.di import get_surreal_repo
from menos.services.storage import SurrealDBRepository

router = APIRouter(prefix="/entities", tags=["entities"])


class EntityResponse(BaseModel):
    """Entity response model."""

    id: str
    entity_type: str
    name: str
    normalized_name: str
    description: str | None = None
    hierarchy: list[str] | None = None
    metadata: dict | None = None
    source: str
    created_at: str | None = None
    updated_at: str | None = None


class EntityListResponse(BaseModel):
    """Paginated entity list."""

    items: list[EntityResponse]
    total: int
    offset: int
    limit: int


class EntityContentResponse(BaseModel):
    """Content linked to an entity."""

    id: str
    title: str | None = None
    content_type: str
    edge_type: str
    confidence: float | None = None


class EntityContentListResponse(BaseModel):
    """List of content linked to entity."""

    items: list[EntityContentResponse]
    total: int


class EntityUpdateRequest(BaseModel):
    """Request model for updating entity."""

    name: str | None = None
    description: str | None = None
    aliases: list[str] | None = None


class TopicNode(BaseModel):
    """Topic in hierarchy."""

    id: str
    name: str
    hierarchy: list[str] | None = None
    children: list["TopicNode"] = []


class TopicHierarchyResponse(BaseModel):
    """Topic hierarchy tree."""

    topics: list[TopicNode]


class DuplicateGroup(BaseModel):
    """Group of potential duplicate entities."""

    entities: list[EntityResponse]


class DuplicatesResponse(BaseModel):
    """List of potential duplicate groups."""

    groups: list[DuplicateGroup]


@router.get("", response_model=EntityListResponse)
async def list_entities(
    key_id: AuthenticatedKeyId,
    entity_type: Annotated[
        str | None,
        Query(description="Filter by entity type (topic, repo, paper, tool, person)"),
    ] = None,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """List entities with optional filtering."""
    etype = None
    if entity_type:
        try:
            etype = EntityType(entity_type)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid entity type: {entity_type}")

    entities, total = await surreal_repo.list_entities(
        entity_type=etype,
        limit=limit,
        offset=offset,
    )

    items = [
        EntityResponse(
            id=e.id or "",
            entity_type=e.entity_type.value,
            name=e.name,
            normalized_name=e.normalized_name,
            description=e.description,
            hierarchy=e.hierarchy,
            metadata=e.metadata,
            source=e.source.value,
            created_at=e.created_at.isoformat() if e.created_at else None,
            updated_at=e.updated_at.isoformat() if e.updated_at else None,
        )
        for e in entities
    ]

    return EntityListResponse(items=items, total=total, offset=offset, limit=limit)


@router.get("/topics", response_model=TopicHierarchyResponse)
async def get_topic_hierarchy(
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get topic hierarchy tree."""
    topics = await surreal_repo.get_topic_hierarchy()

    # Build tree from flat list
    topic_map: dict[str, TopicNode] = {}
    root_topics: list[TopicNode] = []

    # First pass: create nodes
    for t in topics:
        node = TopicNode(
            id=t.id or "",
            name=t.name,
            hierarchy=t.hierarchy,
        )
        topic_map[t.normalized_name] = node

    # Second pass: build tree based on hierarchy
    for t in topics:
        node = topic_map[t.normalized_name]
        if t.hierarchy and len(t.hierarchy) > 1:
            # Find parent by hierarchy
            parent_name = t.hierarchy[-2].lower().replace(" ", "").replace("-", "").replace("_", "")
            if parent_name in topic_map:
                topic_map[parent_name].children.append(node)
            else:
                root_topics.append(node)
        else:
            root_topics.append(node)

    return TopicHierarchyResponse(topics=root_topics)


@router.get("/duplicates", response_model=DuplicatesResponse)
async def get_potential_duplicates(
    key_id: AuthenticatedKeyId,
    max_distance: Annotated[int, Query(ge=1, le=3)] = 1,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get potential duplicate entities based on name similarity."""
    duplicate_groups = await surreal_repo.find_potential_duplicates(max_distance)

    groups = [
        DuplicateGroup(
            entities=[
                EntityResponse(
                    id=e.id or "",
                    entity_type=e.entity_type.value,
                    name=e.name,
                    normalized_name=e.normalized_name,
                    description=e.description,
                    hierarchy=e.hierarchy,
                    metadata=e.metadata,
                    source=e.source.value,
                    created_at=e.created_at.isoformat() if e.created_at else None,
                    updated_at=e.updated_at.isoformat() if e.updated_at else None,
                )
                for e in group
            ]
        )
        for group in duplicate_groups
    ]

    return DuplicatesResponse(groups=groups)


@router.get("/{entity_id}", response_model=EntityResponse)
async def get_entity(
    entity_id: str,
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get entity by ID."""
    entity = await surreal_repo.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    return EntityResponse(
        id=entity.id or "",
        entity_type=entity.entity_type.value,
        name=entity.name,
        normalized_name=entity.normalized_name,
        description=entity.description,
        hierarchy=entity.hierarchy,
        metadata=entity.metadata,
        source=entity.source.value,
        created_at=entity.created_at.isoformat() if entity.created_at else None,
        updated_at=entity.updated_at.isoformat() if entity.updated_at else None,
    )


@router.get("/{entity_id}/content", response_model=EntityContentListResponse)
async def get_entity_content(
    entity_id: str,
    key_id: AuthenticatedKeyId,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get content linked to an entity."""
    # Verify entity exists
    entity = await surreal_repo.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    content_with_edges = await surreal_repo.get_content_for_entity(
        entity_id=entity_id,
        limit=limit,
        offset=offset,
    )

    items = [
        EntityContentResponse(
            id=content.id or "",
            title=content.title,
            content_type=content.content_type,
            edge_type=edge.edge_type.value,
            confidence=edge.confidence,
        )
        for content, edge in content_with_edges
    ]

    return EntityContentListResponse(items=items, total=len(items))


def _build_entity_updates(update_request: EntityUpdateRequest, existing_metadata: dict) -> dict:
    """Build the updates dict for an entity patch request."""
    from menos.services.normalization import normalize_name

    updates = {}
    if update_request.name is not None:
        updates["name"] = update_request.name
        updates["normalized_name"] = normalize_name(update_request.name)
    if update_request.description is not None:
        updates["description"] = update_request.description
    if update_request.aliases is not None:
        meta = dict(existing_metadata)
        meta["aliases"] = update_request.aliases
        updates["metadata"] = meta
    return updates


@router.patch("/{entity_id}", response_model=EntityResponse)
async def update_entity(
    entity_id: str,
    update_request: EntityUpdateRequest,
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Update entity (rename, add aliases, update description)."""
    entity = await surreal_repo.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    updates = _build_entity_updates(update_request, entity.metadata or {})
    if not updates:
        raise HTTPException(status_code=400, detail="No updates provided")

    updated = await surreal_repo.update_entity(entity_id, updates)
    if not updated:
        raise HTTPException(status_code=500, detail="Failed to update entity")

    return EntityResponse(
        id=updated.id or "",
        entity_type=updated.entity_type.value,
        name=updated.name,
        normalized_name=updated.normalized_name,
        description=updated.description,
        hierarchy=updated.hierarchy,
        metadata=updated.metadata,
        source=updated.source.value,
        created_at=updated.created_at.isoformat() if updated.created_at else None,
        updated_at=updated.updated_at.isoformat() if updated.updated_at else None,
    )


@router.delete("/{entity_id}")
async def delete_entity(
    entity_id: str,
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Delete entity and all its edges."""
    entity = await surreal_repo.get_entity(entity_id)
    if not entity:
        raise HTTPException(status_code=404, detail="Entity not found")

    await surreal_repo.delete_entity(entity_id)

    return {"status": "deleted", "id": entity_id}
