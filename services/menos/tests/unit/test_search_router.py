"""Unit tests for PostgreSQL search routing."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from pydantic import ValidationError

from menos.routers.search import AgenticSearchQuery, SearchQuery, agentic_search, vector_search
from menos.services.agent import AgentSearchResult


def test_search_query_normalizes_and_validates_tier():
    assert SearchQuery(query="test", tier_min=" b ").tier_min == "B"
    with pytest.raises(ValidationError, match="tier_min"):
        SearchQuery(query="test", tier_min="X")
    assert AgenticSearchQuery(query="test", tier_min="a").tier_min == "A"


@pytest.mark.asyncio
async def test_vector_search_passes_filters_to_repository():
    embedding_service = MagicMock()
    embedding_service.embed_query = AsyncMock(return_value=[0.1] * 1024)
    repository = MagicMock()
    repository.vector_search = AsyncMock(return_value=[])
    repository.fetch_content_metadata = AsyncMock(return_value={})
    body = SearchQuery(query="test", tags=["python"], tier_min="b", limit=5)

    response = await vector_search(
        body=body,
        key_id="test-key",
        embedding_service=embedding_service,
        surreal_repo=repository,
    )

    assert response.total == 0
    repository.vector_search.assert_awaited_once_with(
        [0.1] * 1024,
        limit=5,
        content_type=None,
        tags=["python"],
        exclude_tags=["test"],
        valid_tiers=["S", "A", "B"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("tags", "requested_exclusions", "expected"),
    [
        (None, None, ["test"]),
        (["test"], None, []),
        (None, [], []),
        (None, ["test", "draft"], ["test", "draft"]),
    ],
)
async def test_vector_search_exclusion_contract(tags, requested_exclusions, expected):
    embedding_service = MagicMock()
    embedding_service.embed_query = AsyncMock(return_value=[0.0] * 1024)
    repository = MagicMock()
    repository.vector_search = AsyncMock(return_value=[])
    repository.fetch_content_metadata = AsyncMock(return_value={})
    body = SearchQuery(
        query="query",
        tags=tags,
        exclude_tags=requested_exclusions,
        limit=10,
    )
    await vector_search(
        body=body,
        key_id="test-key",
        embedding_service=embedding_service,
        surreal_repo=repository,
    )
    assert repository.vector_search.call_args.kwargs["exclude_tags"] == expected


@pytest.mark.asyncio
async def test_agentic_search_passes_normalized_tier():
    service = MagicMock()
    service.search = AsyncMock(
        return_value=AgentSearchResult(
            answer="ok",
            sources=[],
            timing={
                "expansion_ms": 1,
                "retrieval_ms": 1,
                "rerank_ms": 1,
                "synthesis_ms": 1,
                "total_ms": 4,
            },
        )
    )
    response = await agentic_search(
        body=AgenticSearchQuery(query="test", tier_min="c"),
        key_id="test-key",
        agent_service=service,
    )
    assert response.query == "test"
    service.search.assert_awaited_once_with(query="test", content_type=None, tier_min="C", limit=10)
