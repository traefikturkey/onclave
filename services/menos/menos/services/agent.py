"""Agent service for 3-stage agentic search pipeline.

Implements query expansion, multi-query vector search with RRF fusion,
reranking, and answer synthesis with citations.
"""

import json
import time
from dataclasses import dataclass

from menos.services.embeddings import EmbeddingService
from menos.services.llm import LLMProvider
from menos.services.reranker import RerankerProvider
from menos.services.storage import SurrealDBRepository, _compute_valid_tiers

EXPANSION_PROMPT = """Generate 3-5 diverse search queries to find relevant content.
Return JSON: {{"queries": ["query1", "query2", ...]}}
Focus on different aspects and synonyms to maximize recall.

Original question: {query}

Return only JSON, no other text."""


SYNTHESIS_PROMPT = """Based on the following search results, answer the user's question.
Include citations using [1], [2] etc. for each source used.
If the results don't contain relevant information, say so.

Question: {query}

Search Results:
{results}

Provide a comprehensive answer with citations."""


@dataclass
class AgentSearchResult:
    """Result from agentic search pipeline.

    Attributes:
        answer: Synthesized answer with citations
        sources: List of source documents with metadata
        timing: Timing breakdown by stage in milliseconds
    """

    answer: str
    sources: list[dict]  # List of {id, title, content_type, score, snippet}
    timing: dict  # {expansion_ms, retrieval_ms, rerank_ms, synthesis_ms, total_ms}


class AgentService:
    """3-stage agentic search pipeline.

    Stage 1: Query Expansion - Use LLM to generate multiple search queries
    Stage 2: Multi-Query Search with RRF - Execute vector searches and fuse results
    Stage 3: Reranking and Synthesis - Rerank results and generate answer with citations
    """

    def __init__(
        self,
        expansion_provider: LLMProvider,
        reranker: RerankerProvider,
        synthesis_provider: LLMProvider,
        embedding_service: EmbeddingService,
        surreal_repo: SurrealDBRepository,
    ):
        """Initialize agent service with dependencies.

        Args:
            expansion_provider: LLM provider for query expansion
            reranker: Reranker provider for result reranking
            synthesis_provider: LLM provider for answer synthesis
            embedding_service: Embedding service for vector generation
            surreal_repo: SurrealDB repository for vector search
        """
        self.expansion_provider = expansion_provider
        self.reranker = reranker
        self.synthesis_provider = synthesis_provider
        self.embedding_service = embedding_service
        self.surreal_repo = surreal_repo

    async def search(
        self,
        query: str,
        content_type: str | None = None,
        tier_min: str | None = None,
        limit: int = 10,
    ) -> AgentSearchResult:
        """Execute 3-stage agentic search pipeline.

        Args:
            query: User's search query
            content_type: Optional filter by content type
            tier_min: Optional minimum quality tier (S/A/B/C/D)
            limit: Maximum number of results to return

        Returns:
            AgentSearchResult with answer, sources, and timing
        """
        total_start = time.perf_counter()
        timing: dict[str, float] = {}

        # Stage 1: Query Expansion
        expansion_start = time.perf_counter()
        expanded_queries = await self._expand_query(query)
        timing["expansion_ms"] = (time.perf_counter() - expansion_start) * 1000

        # Stage 2: Multi-Query Search with RRF
        retrieval_start = time.perf_counter()
        search_results = await self._search_with_rrf(
            expanded_queries,
            content_type,
            tier_min,
            limit * 2,
        )
        timing["retrieval_ms"] = (time.perf_counter() - retrieval_start) * 1000

        # Stage 3a: Reranking
        rerank_start = time.perf_counter()
        if search_results:
            documents = [r.get("snippet", r.get("text", "")) for r in search_results]
            ranked = await self.reranker.rank(query, documents)

            # Reorder results by reranked scores
            reranked_results = []
            for ranked_doc in ranked[:limit]:
                original = search_results[ranked_doc.original_index]
                original["score"] = ranked_doc.score
                reranked_results.append(original)
            search_results = reranked_results
        timing["rerank_ms"] = (time.perf_counter() - rerank_start) * 1000

        # Stage 3b: Answer Synthesis
        synthesis_start = time.perf_counter()
        answer = await self._synthesize_answer(query, search_results)
        timing["synthesis_ms"] = (time.perf_counter() - synthesis_start) * 1000

        timing["total_ms"] = (time.perf_counter() - total_start) * 1000

        return AgentSearchResult(
            answer=answer,
            sources=search_results,
            timing=timing,
        )

    async def _expand_query(self, query: str) -> list[str]:
        """Expand query into multiple search queries using LLM.

        Args:
            query: Original user query

        Returns:
            List of expanded queries (falls back to [query] on error)
        """
        try:
            prompt = EXPANSION_PROMPT.format(query=query)
            response = await self.expansion_provider.generate(
                prompt=prompt,
                temperature=0.3,
                timeout=30.0,
            )

            # Parse JSON response
            response = response.strip()
            # Handle markdown code blocks
            if response.startswith("```"):
                lines = response.split("\n")
                response = "\n".join(lines[1:-1]) if len(lines) > 2 else response

            data = json.loads(response)
            queries = data.get("queries", [])

            if queries and isinstance(queries, list):
                # Always include original query
                if query not in queries:
                    queries.insert(0, query)
                return queries[:5]

        except (json.JSONDecodeError, KeyError, ValueError, TypeError, RuntimeError):
            pass

        return [query]

    def _build_search_filters(
        self,
        embedding: list[float],
        limit: int,
        content_type: str | None,
        tier_min: str | None,
    ) -> tuple[str, str, dict]:
        """Build SQL filter clauses and query params for vector search."""
        type_filter = ""
        if content_type:
            type_filter = (
                " AND content_id IN "
                f"(SELECT VALUE id FROM content WHERE content_type = '{content_type}')"
            )

        valid_tiers = _compute_valid_tiers(tier_min)
        tier_filter = ""
        if valid_tiers:
            tier_filter = " AND content_id.tier IN $valid_tiers"

        query_params: dict = {"embedding": embedding, "limit": limit}
        if valid_tiers:
            query_params["valid_tiers"] = valid_tiers

        return type_filter, tier_filter, query_params

    def _parse_db_result(self, raw: list) -> list[dict]:
        """Extract records from a raw SurrealDB query result (handles wrapped/unwrapped formats)."""
        if not (raw and isinstance(raw, list)):
            return []
        first = raw[0]
        if isinstance(first, dict) and "result" in first:
            return first["result"]
        if isinstance(first, dict):
            return raw
        return []

    def _group_best_chunks(self, chunks: list[dict]) -> dict[str, tuple[float, str, str]]:
        """Group chunks by content_id, keeping the highest-scoring chunk per content."""
        best_per_content: dict[str, tuple[float, str, str]] = {}
        for chunk in chunks:
            content_id = str(chunk.get("content_id", ""))
            score = float(chunk.get("score", 0.0))
            text = chunk.get("text", "")
            if content_id and (
                content_id not in best_per_content or score > best_per_content[content_id][0]
            ):
                best_per_content[content_id] = (score, text, content_id)
        return best_per_content

    @staticmethod
    def _normalize_record_id(rid: object) -> str:
        """Normalize a SurrealDB RecordID object or string to a plain string."""
        if hasattr(rid, "record_id"):
            return str(rid.record_id)
        if hasattr(rid, "id"):
            return rid.id
        return str(rid)

    def _fetch_content_metadata(self) -> dict[str, dict]:
        """Fetch all content records and return a mapping of id -> metadata."""
        content_results = self.surreal_repo.db.query("SELECT * FROM content")
        content_list = self._parse_db_result(content_results)

        id_to_meta: dict[str, dict] = {}
        for content in content_list:
            rid = self._normalize_record_id(content.get("id"))
            id_to_meta[rid] = {
                "title": content.get("title"),
                "content_type": content.get("content_type", "unknown"),
            }
        return id_to_meta

    async def _vector_search(
        self,
        embedding: list[float],
        limit: int,
        content_type: str | None = None,
        tier_min: str | None = None,
    ) -> list[dict]:
        """Execute vector search in SurrealDB.

        Args:
            embedding: Query embedding vector
            limit: Maximum results to return
            content_type: Optional content type filter
            tier_min: Optional minimum quality tier (S/A/B/C/D)

        Returns:
            List of search results with id, content_type, title, score, snippet
        """
        type_filter, tier_filter, query_params = self._build_search_filters(
            embedding, limit, content_type, tier_min
        )

        search_results = self.surreal_repo.db.query(
            f"""
            SELECT text, content_id,
                   vector::similarity::cosine(embedding, $embedding) AS score
            FROM chunk
            WHERE embedding != NONE
                AND vector::similarity::cosine(embedding, $embedding) > 0.3
                {type_filter}
                {tier_filter}
            ORDER BY score DESC
            LIMIT $limit
            """,
            query_params,
        )

        chunks = self._parse_db_result(search_results)
        best_per_content = self._group_best_chunks(chunks)
        id_to_meta = self._fetch_content_metadata()

        results = []
        for content_id, (score, text, _cid) in best_per_content.items():
            meta = id_to_meta.get(content_id, {})
            results.append(
                {
                    "id": content_id,
                    "content_type": meta.get("content_type", "unknown"),
                    "title": meta.get("title"),
                    "score": round(score, 4),
                    "snippet": text[:500] if text else None,
                }
            )

        results.sort(key=lambda x: x["score"], reverse=True)
        return results[:limit]

    async def _search_with_rrf(
        self,
        queries: list[str],
        content_type: str | None,
        tier_min: str | None,
        limit: int,
    ) -> list[dict]:
        """Execute multi-query search with Reciprocal Rank Fusion.

        Args:
            queries: List of search queries
            content_type: Optional content type filter
            tier_min: Optional minimum quality tier (S/A/B/C/D)
            limit: Maximum results to return

        Returns:
            Fused and sorted search results
        """
        # Collect results from all queries
        all_results: dict[str, dict] = {}
        rrf_scores: dict[str, float] = {}

        for query in queries:
            # Generate embedding for this query
            embedding = await self.embedding_service.embed_query(query)
            results = await self._vector_search(embedding, limit, content_type, tier_min)

            # Apply RRF scoring
            for rank, result in enumerate(results):
                result_id = result["id"]
                rrf_score = self._rrf_score(rank)

                # Accumulate RRF scores
                if result_id in rrf_scores:
                    rrf_scores[result_id] += rrf_score
                else:
                    rrf_scores[result_id] = rrf_score
                    all_results[result_id] = result

        # Update scores with RRF scores and sort
        for result_id, result in all_results.items():
            result["score"] = round(rrf_scores[result_id], 4)

        # Sort by RRF score descending
        sorted_results = sorted(
            all_results.values(),
            key=lambda x: x["score"],
            reverse=True,
        )

        return sorted_results[:limit]

    def _rrf_score(self, rank: int, k: int = 60) -> float:
        """Calculate Reciprocal Rank Fusion score.

        Args:
            rank: 0-indexed rank of document
            k: Smoothing constant (default 60)

        Returns:
            RRF score for this rank
        """
        return 1 / (k + rank)

    async def _synthesize_answer(
        self,
        query: str,
        results: list[dict],
    ) -> str:
        """Synthesize answer from search results using LLM.

        Args:
            query: Original user query
            results: Search results to synthesize from

        Returns:
            Synthesized answer with citations (empty string on error)
        """
        if not results:
            return ""

        try:
            # Format results for prompt
            formatted_results = []
            for i, result in enumerate(results):
                title = result.get("title") or "Untitled"
                snippet = result.get("snippet", "")[:400]
                formatted_results.append(f"[{i + 1}] {title}\n{snippet}")

            results_text = "\n\n".join(formatted_results)
            prompt = SYNTHESIS_PROMPT.format(query=query, results=results_text)

            answer = await self.synthesis_provider.generate(
                prompt=prompt,
                temperature=0.5,
                timeout=60.0,
            )

            return answer.strip()

        except RuntimeError:
            return ""
