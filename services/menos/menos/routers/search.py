"""Search endpoints."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from menos.auth.dependencies import AuthenticatedKeyId
from menos.services.agent import AgentService
from menos.services.di import get_agent_service, get_surreal_repo
from menos.services.embeddings import EmbeddingService, get_embedding_service
from menos.services.storage import SurrealDBRepository, _compute_valid_tiers

router = APIRouter(prefix="/search", tags=["search"])


class SearchQuery(BaseModel):
    """Search request."""

    query: str
    content_type: str | None = None
    tags: list[str] | None = None
    exclude_tags: list[str] | None = None
    tier_min: str | None = None
    entities: list[str] | None = None  # Entity IDs to filter by
    entity_types: list[str] | None = None  # Filter by entity type
    topics: list[str] | None = None  # Filter by topic hierarchy (e.g., "AI > LLMs")
    limit: int = 20

    @field_validator("tier_min", mode="before")
    @classmethod
    def validate_tier_min(cls, value: str | None) -> str | None:
        """Validate and normalize optional minimum quality tier."""
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("tier_min must be one of S, A, B, C, D")

        normalized = value.strip().upper()
        if normalized not in {"S", "A", "B", "C", "D"}:
            raise ValueError("tier_min must be one of S, A, B, C, D")
        return normalized


class SearchResult(BaseModel):
    """Single search result."""

    id: str
    content_type: str
    title: str | None
    score: float
    snippet: str | None = None


class SearchResponse(BaseModel):
    """Search response."""

    query: str
    results: list[SearchResult]
    total: int


class AgenticSearchQuery(BaseModel):
    """Agentic search request."""

    query: str
    content_type: str | None = None
    tier_min: str | None = None
    limit: int = 10

    @field_validator("tier_min", mode="before")
    @classmethod
    def validate_tier_min(cls, value: str | None) -> str | None:
        """Validate and normalize optional minimum quality tier."""
        if value is None:
            return None
        if not isinstance(value, str):
            raise ValueError("tier_min must be one of S, A, B, C, D")

        normalized = value.strip().upper()
        if normalized not in {"S", "A", "B", "C", "D"}:
            raise ValueError("tier_min must be one of S, A, B, C, D")
        return normalized


class SourceReference(BaseModel):
    """Source document reference."""

    id: str
    content_type: str
    title: str | None
    score: float
    snippet: str | None = None


class TimingInfo(BaseModel):
    """Timing breakdown for agentic search."""

    expansion_ms: float
    retrieval_ms: float
    rerank_ms: float
    synthesis_ms: float
    total_ms: float


class AgenticSearchResponse(BaseModel):
    """Agentic search response."""

    query: str
    answer: str
    sources: list[SourceReference]
    timing: TimingInfo


def _resolve_exclude_tags(body: SearchQuery) -> list[str]:
    """Compute effective exclude_tags, defaulting to ['test'] and removing conflicts."""
    exclude_tags = body.exclude_tags if body.exclude_tags is not None else ["test"]
    if body.tags and "test" in body.tags and "test" in exclude_tags:
        exclude_tags = [t for t in exclude_tags if t != "test"]
    return exclude_tags


def _build_search_where_clause(body: SearchQuery, exclude_tags: list[str]) -> tuple[str, dict]:
    """Build the WHERE clause and params dict for the vector search query."""
    where_clause = (
        "WHERE embedding != NONE AND vector::similarity::cosine(embedding, $embedding) > 0.3"
    )
    params: dict = {"limit": body.limit}

    if body.tags:
        where_clause += " AND content_id.tags CONTAINSANY $tags"
        params["tags"] = body.tags

    if exclude_tags:
        where_clause += " AND content_id.tags CONTAINSNONE $exclude_tags"
        params["exclude_tags"] = exclude_tags

    if body.content_type:
        where_clause += " AND content_id.content_type = $content_type"
        params["content_type"] = body.content_type

    valid_tiers = _compute_valid_tiers(body.tier_min)
    if valid_tiers:
        where_clause += " AND content_id.tier IN $valid_tiers"
        params["valid_tiers"] = valid_tiers

    return where_clause, params


def _parse_chunks_result(search_results: list) -> list[dict]:
    """Unpack SurrealDB v2 query result into a flat list of chunks."""
    if not (search_results and isinstance(search_results, list) and len(search_results) > 0):
        return []
    result_item = search_results[0]
    if isinstance(result_item, dict) and "result" in result_item:
        return result_item["result"]
    if isinstance(result_item, dict) and "score" in result_item:
        return search_results
    return []


def _best_chunks_per_content(chunks: list[dict]) -> dict[str, tuple[float, str]]:
    """Group chunks by content_id, keeping the highest-scoring chunk per content."""
    best: dict[str, tuple[float, str]] = {}
    for chunk in chunks:
        content_id = str(chunk.get("content_id", ""))
        score = float(chunk.get("score", 0.0))
        text = chunk.get("text", "")
        if content_id and (content_id not in best or score > best[content_id][0]):
            best[content_id] = (score, text)
    return best


def _parse_content_result(content_results: list) -> list[dict]:
    """Unpack SurrealDB v2 content query result into a flat list."""
    if not (content_results and isinstance(content_results, list) and len(content_results) > 0):
        return []
    result_item = content_results[0]
    if isinstance(result_item, dict) and "result" in result_item:
        return result_item["result"]
    if isinstance(result_item, dict) and "id" in result_item:
        return content_results
    return []


def _extract_content_id(rid) -> str:
    """Normalize a SurrealDB record ID to a plain string ID."""
    if hasattr(rid, "record_id"):
        return str(rid.record_id)
    if hasattr(rid, "id"):
        return rid.id
    return str(rid)


def _fetch_content_metadata(
    surreal_repo: SurrealDBRepository,
    content_ids: list[str],
) -> dict[str, dict]:
    """Fetch title and content_type for a list of content IDs."""
    if not content_ids:
        return {}
    content_refs = [f"content:{cid}" for cid in content_ids]
    content_results = surreal_repo.db.query(
        "SELECT * FROM content WHERE id IN $ids", {"ids": content_refs}
    )
    content_list = _parse_content_result(content_results)
    id_to_meta: dict[str, dict] = {}
    for content in content_list:
        rid = content.get("id")
        cid = _extract_content_id(rid)
        id_to_meta[cid] = {
            "title": content.get("title"),
            "content_type": content.get("content_type", "unknown"),
        }
    return id_to_meta


def _build_search_results(
    best_per_content: dict[str, tuple[float, str]],
    id_to_meta: dict[str, dict],
) -> list[SearchResult]:
    """Sort by score and build SearchResult objects."""
    sorted_items = sorted(best_per_content.items(), key=lambda x: x[1][0], reverse=True)
    results = []
    for content_id, (score, text) in sorted_items:
        meta = id_to_meta.get(content_id, {})
        results.append(
            SearchResult(
                id=content_id,
                content_type=meta.get("content_type", "unknown"),
                title=meta.get("title"),
                score=round(score, 4),
                snippet=text[:200] if text else None,
            )
        )
    return results


@router.post("", response_model=SearchResponse)
async def vector_search(
    body: SearchQuery,
    key_id: AuthenticatedKeyId,
    embedding_service: EmbeddingService = Depends(get_embedding_service),
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Semantic vector search across content.

    Supports filtering by:
    - content_type: Type of content (youtube, markdown, etc.)
    - tags: Content can have ANY of the specified tags
    - exclude_tags: Tags to exclude (defaults to ["test"] if None)
    - tier_min: Minimum quality tier (S, A, B, C, D)
    - entities: Content must be linked to ALL specified entity IDs
    - entity_types: Content must have entities of specified types
    - topics: Content must discuss topics matching the hierarchy pattern
    """
    query_embedding = await embedding_service.embed_query(body.query)
    exclude_tags = _resolve_exclude_tags(body)
    where_clause, params = _build_search_where_clause(body, exclude_tags)
    params["embedding"] = query_embedding

    search_results = surreal_repo.db.query(
        f"""
        SELECT text, content_id,
               vector::similarity::cosine(embedding, $embedding) AS score
        FROM chunk
        {where_clause}
        ORDER BY score DESC
        LIMIT $limit
        """,
        params,
    )

    chunks = _parse_chunks_result(search_results)
    best_per_content = _best_chunks_per_content(chunks)

    if body.entities or body.entity_types or body.topics:
        filtered_content = await _filter_by_entities(
            surreal_repo,
            list(best_per_content.keys()),
            body.entities,
            body.entity_types,
            body.topics,
        )
        best_per_content = {k: v for k, v in best_per_content.items() if k in filtered_content}

    id_to_meta = _fetch_content_metadata(surreal_repo, list(best_per_content.keys()))
    results = _build_search_results(best_per_content, id_to_meta)

    return SearchResponse(
        query=body.query,
        results=results,
        total=len(results),
    )


def _extract_cid_from_item(item: dict) -> str:
    """Extract plain content ID string from a content_entity result item."""
    cid = item.get("content_id")
    if hasattr(cid, "id"):
        return cid.id
    return str(cid).split(":")[-1]


def _filter_by_entity_ids(
    surreal_repo: SurrealDBRepository,
    matching: set[str],
    entity_ids: list[str],
) -> set[str]:
    """Narrow matching set to content linked to ALL given entity IDs."""
    for entity_ref in [f"entity:{eid}" for eid in entity_ids]:
        result = surreal_repo.db.query(
            """
            SELECT content_id FROM content_entity
            WHERE entity_id = $entity_id AND content_id IN $content_ids
            """,
            {
                "entity_id": entity_ref,
                "content_ids": [f"content:{cid}" for cid in matching],
            },
        )
        raw_items = surreal_repo._parse_query_result(result)
        matched = {_extract_cid_from_item(item) for item in raw_items}
        matching &= matched
    return matching


def _filter_by_entity_types(
    surreal_repo: SurrealDBRepository,
    matching: set[str],
    entity_types: list[str],
) -> set[str]:
    """Narrow matching set to content that has entities of the given types."""
    result = surreal_repo.db.query(
        """
        SELECT content_id FROM content_entity
        WHERE content_id IN $content_ids
        AND entity_id.entity_type IN $entity_types
        """,
        {
            "content_ids": [f"content:{cid}" for cid in matching],
            "entity_types": entity_types,
        },
    )
    raw_items = surreal_repo._parse_query_result(result)
    matched = {_extract_cid_from_item(item) for item in raw_items}
    return matching & matched


def _filter_by_topic_pattern(
    surreal_repo: SurrealDBRepository,
    matching: set[str],
    topic_pattern: str,
) -> set[str]:
    """Narrow matching set to content discussing a single topic hierarchy pattern."""
    hierarchy = [p.strip() for p in topic_pattern.split(">")]
    result = surreal_repo.db.query(
        """
        SELECT content_id FROM content_entity
        WHERE content_id IN $content_ids
        AND entity_id.entity_type = 'topic'
        AND entity_id.hierarchy CONTAINSALL $hierarchy
        """,
        {
            "content_ids": [f"content:{cid}" for cid in matching],
            "hierarchy": hierarchy,
        },
    )
    raw_items = surreal_repo._parse_query_result(result)
    matched = {_extract_cid_from_item(item) for item in raw_items}
    return matching & matched


async def _filter_by_entities(
    surreal_repo: SurrealDBRepository,
    content_ids: list[str],
    entity_ids: list[str] | None,
    entity_types: list[str] | None,
    topics: list[str] | None,
) -> set[str]:
    """Filter content IDs by entity constraints.

    Args:
        surreal_repo: Database repository
        content_ids: Content IDs to filter
        entity_ids: Must be linked to ALL these entities
        entity_types: Must have entities of these types
        topics: Must discuss topics matching these patterns

    Returns:
        Set of content IDs that match all constraints
    """
    if not content_ids:
        return set()

    matching = set(content_ids)

    if entity_ids:
        matching = _filter_by_entity_ids(surreal_repo, matching, entity_ids)

    if entity_types and matching:
        matching = _filter_by_entity_types(surreal_repo, matching, entity_types)

    if topics and matching:
        for topic_pattern in topics:
            matching = _filter_by_topic_pattern(surreal_repo, matching, topic_pattern)

    return matching


@router.post("/agentic", response_model=AgenticSearchResponse)
async def agentic_search(
    body: AgenticSearchQuery,
    key_id: AuthenticatedKeyId,
    agent_service: AgentService = Depends(get_agent_service),
):
    """Agentic search with LLM-powered query expansion, reranking, and answer synthesis."""
    result = await agent_service.search(
        query=body.query,
        content_type=body.content_type,
        tier_min=body.tier_min,
        limit=body.limit,
    )

    sources = [SourceReference(**s) for s in result.sources]
    timing = TimingInfo(**result.timing)

    return AgenticSearchResponse(
        query=body.query,
        answer=result.answer,
        sources=sources,
        timing=timing,
    )
