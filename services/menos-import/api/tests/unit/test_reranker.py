"""Unit tests for reranker providers."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from menos.services.reranker import (
    LLMRerankerProvider,
    NoOpRerankerProvider,
    RankedDocument,
    RerankerLibraryProvider,
    RerankerProvider,
)

# -- RankedDocument ----------------------------------------------------------


class TestRankedDocument:
    """Tests for the RankedDocument dataclass."""

    def test_fields(self):
        """All fields are accessible."""
        doc = RankedDocument(text="hello", original_index=2, score=0.85)
        assert doc.text == "hello"
        assert doc.original_index == 2
        assert doc.score == 0.85

    def test_equality(self):
        """Dataclass equality compares all fields."""
        a = RankedDocument(text="x", original_index=0, score=1.0)
        b = RankedDocument(text="x", original_index=0, score=1.0)
        assert a == b


# -- NoOpRerankerProvider ----------------------------------------------------


class TestNoOpRerankerProvider:
    """Tests for the no-op reranker."""

    def test_satisfies_protocol(self):
        """NoOpRerankerProvider satisfies RerankerProvider protocol."""
        assert isinstance(NoOpRerankerProvider(), RerankerProvider)

    @pytest.mark.asyncio
    async def test_rank_returns_original_order(self):
        """Documents returned in original order with score=1.0."""
        reranker = NoOpRerankerProvider()
        docs = ["first", "second", "third"]

        ranked = await reranker.rank("any query", docs)

        assert len(ranked) == 3
        for i, doc in enumerate(docs):
            assert ranked[i].text == doc
            assert ranked[i].original_index == i
            assert ranked[i].score == 1.0

    @pytest.mark.asyncio
    async def test_rank_empty_list(self):
        """Empty input returns empty output."""
        reranker = NoOpRerankerProvider()
        ranked = await reranker.rank("query", [])
        assert ranked == []

    @pytest.mark.asyncio
    async def test_close_is_noop(self):
        """close() does not raise."""
        reranker = NoOpRerankerProvider()
        await reranker.close()


# -- LLMRerankerProvider -----------------------------------------------------


class TestLLMRerankerProviderInit:
    """Tests for LLMRerankerProvider initialization."""

    def test_stores_llm_provider(self):
        """Constructor stores the llm_provider reference."""
        mock_llm = AsyncMock()
        reranker = LLMRerankerProvider(mock_llm)
        assert reranker.llm_provider is mock_llm


class TestLLMRerankerProviderRank:
    """Tests for the LLM-based ranking."""

    @pytest.mark.asyncio
    async def test_rank_empty_documents(self):
        """Empty document list returns empty result."""
        mock_llm = AsyncMock()
        reranker = LLMRerankerProvider(mock_llm)

        result = await reranker.rank("query", [])
        assert result == []
        mock_llm.generate.assert_not_called()

    @pytest.mark.asyncio
    async def test_rank_valid_json_response(self):
        """Valid JSON rankings are parsed and sorted by score desc."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({
                "rankings": [
                    {"index": 0, "score": 0.3},
                    {"index": 1, "score": 0.9},
                    {"index": 2, "score": 0.6},
                ]
            })
        )

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["doc-a", "doc-b", "doc-c"]

        ranked = await reranker.rank("test query", docs)

        assert len(ranked) == 3
        # Sorted by score descending
        assert ranked[0].text == "doc-b"
        assert ranked[0].score == 0.9
        assert ranked[0].original_index == 1
        assert ranked[1].text == "doc-c"
        assert ranked[1].score == 0.6
        assert ranked[2].text == "doc-a"
        assert ranked[2].score == 0.3

    @pytest.mark.asyncio
    async def test_rank_markdown_wrapped_json(self):
        """Handles JSON wrapped in markdown code blocks."""
        response = "```json\n" + json.dumps({
            "rankings": [
                {"index": 0, "score": 0.8},
                {"index": 1, "score": 0.5},
            ]
        }) + "\n```"

        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(return_value=response)

        reranker = LLMRerankerProvider(mock_llm)
        ranked = await reranker.rank("q", ["a", "b"])

        assert len(ranked) == 2
        assert ranked[0].score == 0.8

    @pytest.mark.asyncio
    async def test_rank_invalid_json_falls_back(self):
        """Invalid JSON falls back to original order."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(return_value="not json at all")

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["alpha", "beta"]

        ranked = await reranker.rank("query", docs)

        assert len(ranked) == 2
        assert ranked[0].text == "alpha"
        assert ranked[0].original_index == 0
        assert ranked[0].score == 1.0
        assert ranked[1].text == "beta"

    @pytest.mark.asyncio
    async def test_rank_missing_rankings_key_falls_back(self):
        """JSON without 'rankings' key falls back to original order."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({"results": [{"index": 0}]})
        )

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["only-doc"]

        ranked = await reranker.rank("q", docs)

        assert len(ranked) == 1
        assert ranked[0].text == "only-doc"
        assert ranked[0].score == 1.0

    @pytest.mark.asyncio
    async def test_rank_out_of_bounds_index_skipped(self):
        """Rankings with out-of-bounds indices are skipped."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({
                "rankings": [
                    {"index": 0, "score": 0.9},
                    {"index": 99, "score": 0.8},  # out of bounds
                    {"index": -1, "score": 0.7},  # negative
                ]
            })
        )

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["only"]

        ranked = await reranker.rank("q", docs)

        assert len(ranked) == 1
        assert ranked[0].original_index == 0

    @pytest.mark.asyncio
    async def test_rank_empty_rankings_falls_back(self):
        """Empty rankings list falls back to original order."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({"rankings": []})
        )

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["a", "b"]

        ranked = await reranker.rank("q", docs)

        assert len(ranked) == 2
        assert ranked[0].score == 1.0

    @pytest.mark.asyncio
    async def test_rank_runtime_error_propagates(self):
        """RuntimeError from LLM propagates (not caught by parse handler)."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            side_effect=RuntimeError("LLM down")
        )

        reranker = LLMRerankerProvider(mock_llm)
        docs = ["x", "y"]

        with pytest.raises(RuntimeError, match="LLM down"):
            await reranker.rank("q", docs)

    @pytest.mark.asyncio
    async def test_rank_uses_temperature_zero(self):
        """LLM is called with temperature=0.0 for deterministic ranking."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({
                "rankings": [{"index": 0, "score": 0.5}]
            })
        )

        reranker = LLMRerankerProvider(mock_llm)
        await reranker.rank("q", ["doc"])

        call_kwargs = mock_llm.generate.call_args.kwargs
        assert call_kwargs["temperature"] == 0.0
        assert call_kwargs["timeout"] == 30.0

    @pytest.mark.asyncio
    async def test_rank_truncates_long_documents(self):
        """Documents longer than 200 chars are truncated in prompt."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({
                "rankings": [{"index": 0, "score": 0.5}]
            })
        )

        reranker = LLMRerankerProvider(mock_llm)
        long_doc = "x" * 300
        await reranker.rank("q", [long_doc])

        prompt = mock_llm.generate.call_args.kwargs["prompt"]
        # Document should be truncated to 200 chars + "..."
        assert "x" * 200 + "..." in prompt
        assert "x" * 300 not in prompt

    @pytest.mark.asyncio
    async def test_rank_score_default_zero(self):
        """Missing score in ranking defaults to 0.0."""
        mock_llm = AsyncMock()
        mock_llm.generate = AsyncMock(
            return_value=json.dumps({
                "rankings": [{"index": 0}]
            })
        )

        reranker = LLMRerankerProvider(mock_llm)
        ranked = await reranker.rank("q", ["doc"])

        assert ranked[0].score == 0.0


class TestLLMRerankerProviderClose:
    """Tests for resource cleanup."""

    @pytest.mark.asyncio
    async def test_close_delegates_to_llm_provider(self):
        """close() calls close on the underlying LLM provider."""
        mock_llm = AsyncMock()
        reranker = LLMRerankerProvider(mock_llm)

        await reranker.close()
        mock_llm.close.assert_called_once()


# -- RerankerLibraryProvider -------------------------------------------------


class TestRerankerLibraryProvider:
    """Tests for the rerankers-library-based provider."""

    def test_import_error_when_missing(self):
        """Raises ImportError when rerankers library is unavailable."""
        # Reset singleton so __init__ runs again
        RerankerLibraryProvider._instance = None

        with patch.dict("sys.modules", {"rerankers": None}):
            with pytest.raises(ImportError, match="rerankers library"):
                RerankerLibraryProvider.__new__(RerankerLibraryProvider)
                # Remove _initialized to force init
                if hasattr(RerankerLibraryProvider._instance, "_initialized"):
                    del RerankerLibraryProvider._instance._initialized
                RerankerLibraryProvider._instance = None
                RerankerLibraryProvider()

        # Clean up singleton
        RerankerLibraryProvider._instance = None

    @pytest.mark.asyncio
    async def test_rank_empty_documents(self):
        """Empty document list returns empty result immediately."""
        # Reset singleton
        RerankerLibraryProvider._instance = None

        mock_reranker_mod = MagicMock()
        with patch.dict("sys.modules", {"rerankers": mock_reranker_mod}):
            provider = RerankerLibraryProvider()
            result = await provider.rank("query", [])
            assert result == []

        # Clean up
        RerankerLibraryProvider._instance = None
        RerankerLibraryProvider._executor = None
        RerankerLibraryProvider._reranker = None

    @pytest.mark.asyncio
    async def test_rank_delegates_to_thread(self):
        """rank() runs _rank_sync in a thread pool executor."""
        RerankerLibraryProvider._instance = None

        mock_reranker_mod = MagicMock()
        with patch.dict("sys.modules", {"rerankers": mock_reranker_mod}):
            provider = RerankerLibraryProvider()

        # Mock the synchronous ranking
        expected = [
            RankedDocument(text="a", original_index=0, score=0.9),
        ]
        provider._rank_sync = MagicMock(return_value=expected)

        with patch("asyncio.get_event_loop") as mock_loop:
            mock_loop.return_value.run_in_executor = AsyncMock(
                return_value=expected
            )
            result = await provider.rank("q", ["a"])

        assert result == expected

        # Clean up
        RerankerLibraryProvider._instance = None
        RerankerLibraryProvider._executor = None
        RerankerLibraryProvider._reranker = None

    @pytest.mark.asyncio
    async def test_close_shuts_down_executor(self):
        """close() shuts down the thread pool executor."""
        RerankerLibraryProvider._instance = None

        mock_reranker_mod = MagicMock()
        with patch.dict("sys.modules", {"rerankers": mock_reranker_mod}):
            provider = RerankerLibraryProvider()

        mock_executor = MagicMock()
        RerankerLibraryProvider._executor = mock_executor

        await provider.close()

        mock_executor.shutdown.assert_called_once_with(wait=True)
        assert RerankerLibraryProvider._executor is None
        assert RerankerLibraryProvider._reranker is None

        # Clean up
        RerankerLibraryProvider._instance = None

    @pytest.mark.asyncio
    async def test_close_safe_when_no_executor(self):
        """close() is safe when executor is already None."""
        RerankerLibraryProvider._instance = None

        mock_reranker_mod = MagicMock()
        with patch.dict("sys.modules", {"rerankers": mock_reranker_mod}):
            provider = RerankerLibraryProvider()

        RerankerLibraryProvider._executor = None

        await provider.close()  # Should not raise

        # Clean up
        RerankerLibraryProvider._instance = None

    def test_rank_sync_loads_model_and_ranks(self):
        """_rank_sync loads model on first call and converts results."""
        RerankerLibraryProvider._instance = None
        RerankerLibraryProvider._reranker = None

        mock_reranker_mod = MagicMock()
        with patch.dict("sys.modules", {"rerankers": mock_reranker_mod}):
            provider = RerankerLibraryProvider()

        # Mock the Reranker class and its result
        mock_result_item = MagicMock()
        mock_result_item.text = "doc text"
        mock_result_item.doc_id = 0
        mock_result_item.score = 0.95

        mock_results = MagicMock()
        mock_results.results = [mock_result_item]

        mock_reranker_instance = MagicMock()
        mock_reranker_instance.rank.return_value = mock_results
        provider._Reranker = MagicMock(return_value=mock_reranker_instance)

        ranked = provider._rank_sync("query", ["doc text"])

        assert len(ranked) == 1
        assert ranked[0].text == "doc text"
        assert ranked[0].original_index == 0
        assert ranked[0].score == 0.95

        # Clean up
        RerankerLibraryProvider._instance = None
        RerankerLibraryProvider._executor = None
        RerankerLibraryProvider._reranker = None
