"""Unit tests for agent service."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.services.agent import AgentSearchResult, AgentService
from menos.services.reranker import NoOpRerankerProvider, RankedDocument


@pytest.fixture
def mock_expansion_provider():
    """Mock LLM provider for query expansion."""
    provider = AsyncMock()
    # Return a valid JSON response by default (tests can override)
    provider.generate = AsyncMock(return_value='{"queries": ["default query"]}')
    provider.close = AsyncMock()
    return provider


@pytest.fixture
def mock_synthesis_provider():
    """Mock LLM provider for answer synthesis."""
    provider = AsyncMock()
    provider.generate = AsyncMock(
        return_value="This is a synthesized answer with citations [1] and [2]."
    )
    provider.close = AsyncMock()
    return provider


@pytest.fixture
def mock_reranker():
    """Mock reranker provider."""
    reranker = AsyncMock()
    reranker.rank = AsyncMock(
        return_value=[
            RankedDocument(text="doc1", original_index=0, score=0.9),
            RankedDocument(text="doc2", original_index=1, score=0.7),
        ]
    )
    reranker.close = AsyncMock()
    return reranker


@pytest.fixture
def mock_embedding_service():
    """Mock embedding service."""
    service = AsyncMock()
    service.embed_query = AsyncMock(return_value=[0.1] * 1024)
    service.close = AsyncMock()
    return service


@pytest.fixture
def mock_surreal_repo():
    """Mock the PostgreSQL repository boundary."""
    repo = MagicMock()
    repo.vector_search = AsyncMock(return_value=[])
    repo.fetch_content_metadata = AsyncMock(return_value={})
    return repo


@pytest.fixture
def agent_service(
    mock_expansion_provider,
    mock_reranker,
    mock_synthesis_provider,
    mock_embedding_service,
    mock_surreal_repo,
):
    """Create AgentService with mocked dependencies."""
    return AgentService(
        expansion_provider=mock_expansion_provider,
        reranker=mock_reranker,
        synthesis_provider=mock_synthesis_provider,
        embedding_service=mock_embedding_service,
        surreal_repo=mock_surreal_repo,
    )


class TestAgentService:
    """Tests for 3-stage agentic search pipeline."""

    @pytest.mark.asyncio
    async def test_expand_query_valid_json(self):
        """Test query expansion with valid JSON response."""
        # Create mock provider with specific return value
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            return_value=json.dumps(
                {"queries": ["python tutorial", "python guide", "learn python"]}
            )
        )

        # Create service with mock
        service = AgentService(
            expansion_provider=mock_provider,
            reranker=AsyncMock(),
            synthesis_provider=AsyncMock(),
            embedding_service=AsyncMock(),
            surreal_repo=MagicMock(),
        )

        queries = await service._expand_query("python")

        assert len(queries) == 4  # Original + 3 expanded
        assert "python" in queries  # Original query preserved
        assert "python tutorial" in queries
        assert "python guide" in queries
        assert "learn python" in queries

    @pytest.mark.asyncio
    async def test_expand_query_valid_json_without_original(self):
        """Test query expansion adds original query if not present."""
        # Create mock provider
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            return_value=json.dumps({"queries": ["expanded1", "expanded2"]})
        )

        service = AgentService(
            expansion_provider=mock_provider,
            reranker=AsyncMock(),
            synthesis_provider=AsyncMock(),
            embedding_service=AsyncMock(),
            surreal_repo=MagicMock(),
        )

        queries = await service._expand_query("original")

        assert queries[0] == "original"  # Original is first
        assert "expanded1" in queries
        assert "expanded2" in queries

    @pytest.mark.asyncio
    async def test_expand_query_with_markdown_wrapper(self):
        """Test query expansion handles markdown-wrapped JSON."""
        # Create mock provider
        mock_provider = AsyncMock()
        mock_provider.generate = AsyncMock(
            return_value="""```json
{"queries": ["query1", "query2"]}
```"""
        )

        service = AgentService(
            expansion_provider=mock_provider,
            reranker=AsyncMock(),
            synthesis_provider=AsyncMock(),
            embedding_service=AsyncMock(),
            surreal_repo=MagicMock(),
        )

        queries = await service._expand_query("test")

        assert len(queries) == 3  # Original + 2 expanded
        assert "test" in queries
        assert "query1" in queries

    @pytest.mark.asyncio
    async def test_expand_query_invalid_json_fallback(self, agent_service, mock_expansion_provider):
        """Test fallback to [query] on invalid JSON."""
        mock_expansion_provider.generate.return_value = "This is not JSON"

        queries = await agent_service._expand_query("test query")

        assert queries == ["test query"]

    @pytest.mark.asyncio
    async def test_expand_query_missing_queries_key_fallback(
        self, agent_service, mock_expansion_provider
    ):
        """Test fallback when JSON lacks 'queries' key."""
        mock_expansion_provider.generate.return_value = json.dumps({"results": ["a", "b"]})

        queries = await agent_service._expand_query("test")

        assert queries == ["test"]

    @pytest.mark.asyncio
    async def test_expand_query_empty_queries_fallback(
        self, agent_service, mock_expansion_provider
    ):
        """Test fallback when queries list is empty."""
        mock_expansion_provider.generate.return_value = json.dumps({"queries": []})

        queries = await agent_service._expand_query("test")

        assert queries == ["test"]

    @pytest.mark.asyncio
    async def test_expand_query_runtime_error_fallback(
        self, agent_service, mock_expansion_provider
    ):
        """Test fallback when LLM provider raises RuntimeError."""
        mock_expansion_provider.generate.side_effect = RuntimeError("LLM failed")

        queries = await agent_service._expand_query("test")

        assert queries == ["test"]

    @pytest.mark.asyncio
    async def test_expand_query_limits_to_5_queries(self, agent_service, mock_expansion_provider):
        """Test query expansion limits to 5 queries max."""
        mock_expansion_provider.generate.return_value = json.dumps(
            {
                "queries": [
                    "query1",
                    "query2",
                    "query3",
                    "query4",
                    "query5",
                    "query6",
                    "query7",
                ]
            }
        )

        queries = await agent_service._expand_query("original")

        assert len(queries) <= 5

    def test_rrf_score(self, agent_service):
        """Test RRF score calculation."""
        # RRF formula: 1 / (k + rank), k=60 by default
        assert agent_service._rrf_score(0) == 1 / 60  # Rank 0
        assert agent_service._rrf_score(1) == 1 / 61  # Rank 1
        assert agent_service._rrf_score(10) == 1 / 70  # Rank 10

    def test_rrf_score_custom_k(self, agent_service):
        """Test RRF score with custom k parameter."""
        assert agent_service._rrf_score(0, k=10) == 1 / 10
        assert agent_service._rrf_score(5, k=100) == 1 / 105

    @pytest.mark.asyncio
    async def test_vector_search(self, agent_service, mock_embedding_service, mock_surreal_repo):
        """Test vector search executes query and parses results."""
        mock_surreal_repo.vector_search.return_value = [
            {"text": "Chunk text 1", "content_id": "content:1", "score": 0.85},
            {"text": "Chunk text 2", "content_id": "content:1", "score": 0.75},
        ]
        mock_surreal_repo.fetch_content_metadata.return_value = {
            "content:1": {
                "id": "content:1",
                "title": "Test Content",
                "content_type": "video",
            }
        }

        results = await agent_service._vector_search([0.1] * 1024, limit=10)

        assert len(results) == 1  # Deduplicated by content_id
        assert results[0]["id"] == "content:1"
        assert results[0]["title"] == "Test Content"
        assert results[0]["content_type"] == "video"
        assert results[0]["score"] == 0.85  # Higher score kept

    @pytest.mark.asyncio
    async def test_vector_search_with_content_type_filter(self, agent_service, mock_surreal_repo):
        """Test vector search includes content type filter in query."""
        await agent_service._vector_search([0.1] * 1024, limit=10, content_type="video")

        assert mock_surreal_repo.vector_search.call_args.kwargs["content_type"] == "video"

    @pytest.mark.asyncio
    async def test_search_with_rrf_fusion(
        self, agent_service, mock_embedding_service, mock_surreal_repo
    ):
        """Test RRF fusion combines results from multiple queries."""
        # Mock embedding service to return embeddings
        mock_embedding_service.embed_query.return_value = [0.1] * 1024

        mock_surreal_repo.vector_search.side_effect = [
            [
                {"text": "Result A", "content_id": "content:A", "score": 0.9},
                {"text": "Result B", "content_id": "content:B", "score": 0.8},
            ],
            [
                {"text": "Result B", "content_id": "content:B", "score": 0.85},
                {"text": "Result C", "content_id": "content:C", "score": 0.7},
            ],
        ]
        mock_surreal_repo.fetch_content_metadata.side_effect = [
            {
                "content:A": {"title": "Content A", "content_type": "video"},
                "content:B": {"title": "Content B", "content_type": "video"},
            },
            {
                "content:B": {"title": "Content B", "content_type": "video"},
                "content:C": {"title": "Content C", "content_type": "video"},
            },
        ]

        queries = ["query1", "query2"]
        results = await agent_service._search_with_rrf(queries, None, None, limit=10)

        # Result B should rank highest (appeared in both queries)
        assert len(results) == 3  # A, B, C
        assert results[0]["id"] == "content:B"  # Highest RRF score

    @pytest.mark.asyncio
    async def test_rerank_with_noop_preserves_order(self, mock_embedding_service):
        """Test NoOpRerankerProvider preserves original order."""
        noop_reranker = NoOpRerankerProvider()

        documents = ["doc1", "doc2", "doc3"]
        ranked = await noop_reranker.rank("query", documents)

        assert len(ranked) == 3
        assert ranked[0].text == "doc1"
        assert ranked[0].original_index == 0
        assert ranked[0].score == 1.0
        assert ranked[1].text == "doc2"
        assert ranked[2].text == "doc3"

    @pytest.mark.asyncio
    async def test_synthesis_with_citations(self, agent_service, mock_synthesis_provider):
        """Test answer synthesis formats results with citations."""
        results = [
            {"id": "1", "title": "First Result", "snippet": "First snippet", "score": 0.9},
            {"id": "2", "title": "Second Result", "snippet": "Second snippet", "score": 0.8},
        ]

        answer = await agent_service._synthesize_answer("test query", results)

        assert answer == "This is a synthesized answer with citations [1] and [2]."

        # Verify prompt formatting
        call_args = mock_synthesis_provider.generate.call_args
        prompt = call_args.kwargs["prompt"]
        assert "[1] First Result" in prompt
        assert "[2] Second Result" in prompt
        assert "First snippet" in prompt

    @pytest.mark.asyncio
    async def test_synthesis_empty_results(self, agent_service):
        """Test synthesis returns empty string for empty results."""
        answer = await agent_service._synthesize_answer("test", [])

        assert answer == ""

    @pytest.mark.asyncio
    async def test_synthesis_runtime_error_fallback(self, agent_service, mock_synthesis_provider):
        """Test synthesis returns empty string on RuntimeError."""
        mock_synthesis_provider.generate.side_effect = RuntimeError("LLM failed")

        results = [{"id": "1", "title": "Test", "snippet": "Test snippet", "score": 0.9}]
        answer = await agent_service._synthesize_answer("query", results)

        assert answer == ""

    @pytest.mark.asyncio
    async def test_synthesis_truncates_long_snippets(self, agent_service, mock_synthesis_provider):
        """Test synthesis truncates snippets to 400 characters."""
        long_snippet = "x" * 500
        results = [
            {"id": "1", "title": "Test", "snippet": long_snippet, "score": 0.9},
        ]

        await agent_service._synthesize_answer("query", results)

        call_args = mock_synthesis_provider.generate.call_args
        prompt = call_args.kwargs["prompt"]
        # Should contain truncated version (400 chars)
        assert "x" * 400 in prompt
        assert "x" * 500 not in prompt

    @pytest.mark.asyncio
    async def test_synthesis_handles_untitled_content(self, agent_service, mock_synthesis_provider):
        """Test synthesis uses 'Untitled' for missing titles."""
        results = [
            {"id": "1", "title": None, "snippet": "Test snippet", "score": 0.9},
        ]

        await agent_service._synthesize_answer("query", results)

        call_args = mock_synthesis_provider.generate.call_args
        prompt = call_args.kwargs["prompt"]
        assert "[1] Untitled" in prompt

    @pytest.mark.asyncio
    async def test_full_pipeline(self):
        """Test complete search flow with all stages."""
        # Create mocks
        mock_expansion = AsyncMock()
        mock_expansion.generate = AsyncMock(return_value=json.dumps({"queries": ["test query"]}))

        mock_synthesis = AsyncMock()
        mock_synthesis.generate = AsyncMock(
            return_value="This is a synthesized answer with citations [1]."
        )

        mock_embedding = AsyncMock()
        mock_embedding.embed_query = AsyncMock(return_value=[0.1] * 1024)

        mock_reranker = AsyncMock()
        # Reranker returns only 1 document matching the search results
        mock_reranker.rank = AsyncMock(
            return_value=[
                RankedDocument(text="snippet1", original_index=0, score=0.95),
            ]
        )

        mock_repo = MagicMock()
        mock_repo.vector_search = AsyncMock(
            return_value=[{"text": "snippet1", "content_id": "content:1", "score": 0.8}]
        )
        mock_repo.fetch_content_metadata = AsyncMock(
            return_value={"content:1": {"title": "Result 1", "content_type": "video"}}
        )

        service = AgentService(
            expansion_provider=mock_expansion,
            reranker=mock_reranker,
            synthesis_provider=mock_synthesis,
            embedding_service=mock_embedding,
            surreal_repo=mock_repo,
        )

        result = await service.search("test query", limit=10)

        # Verify result structure
        assert isinstance(result, AgentSearchResult)
        assert result.answer == "This is a synthesized answer with citations [1]."
        assert len(result.sources) > 0
        assert "expansion_ms" in result.timing
        assert "retrieval_ms" in result.timing
        assert "rerank_ms" in result.timing
        assert "synthesis_ms" in result.timing
        assert "total_ms" in result.timing
        assert result.timing["total_ms"] > 0

    @pytest.mark.asyncio
    async def test_full_pipeline_with_content_type_filter(self, agent_service, mock_surreal_repo):
        """Test search pipeline with content type filter."""
        await agent_service.search("test", content_type="video", limit=10)

        assert mock_surreal_repo.vector_search.call_count == 2
        assert all(
            call.kwargs["content_type"] == "video"
            for call in mock_surreal_repo.vector_search.call_args_list
        )

    @pytest.mark.asyncio
    async def test_vector_search_with_tier_filter(self, agent_service, mock_surreal_repo):
        """Test vector search includes tier filter in query params."""
        await agent_service._vector_search([0.1] * 1024, limit=10, tier_min="b")

        assert mock_surreal_repo.vector_search.call_args.kwargs["valid_tiers"] == [
            "S",
            "A",
            "B",
        ]

    @pytest.mark.asyncio
    async def test_search_propagates_tier_min_to_all_subqueries(self, agent_service):
        """Test tier_min is propagated through all vector subqueries."""
        agent_service._expand_query = AsyncMock(return_value=["q1", "q2", "q3"])
        agent_service._vector_search = AsyncMock(return_value=[])

        await agent_service.search("test", tier_min="A", limit=5)

        assert agent_service._vector_search.call_count == 3
        for call in agent_service._vector_search.call_args_list:
            assert call.args[3] == "A"

    @pytest.mark.asyncio
    async def test_reranking_reorders_results(self, agent_service, mock_reranker):
        """Test reranking changes result order based on scores."""
        agent_service.surreal_repo.vector_search.side_effect = [
            [
                {"text": "low relevance", "content_id": "content:1", "score": 0.9},
                {"text": "high relevance", "content_id": "content:2", "score": 0.8},
            ],
            [],
        ]
        agent_service.surreal_repo.fetch_content_metadata.side_effect = [
            {
                "content:1": {"title": "Low", "content_type": "video"},
                "content:2": {"title": "High", "content_type": "video"},
            },
            {},
        ]

        # Reranker reverses the order
        mock_reranker.rank.return_value = [
            RankedDocument(text="high relevance", original_index=1, score=0.95),
            RankedDocument(text="low relevance", original_index=0, score=0.6),
        ]

        result = await agent_service.search("test", limit=10)

        # After reranking, content:2 should be first
        assert result.sources[0]["id"] == "content:2"
        assert result.sources[0]["score"] == 0.95
        assert result.sources[1]["id"] == "content:1"
        assert result.sources[1]["score"] == 0.6

    @pytest.mark.asyncio
    async def test_empty_search_results(self, agent_service):
        """Test pipeline handles empty search results gracefully."""
        result = await agent_service.search("test", limit=10)

        assert result.answer == ""
        assert result.sources == []
        assert result.timing["total_ms"] > 0
