"""Tests for unified pipeline orchestration service."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import EdgeType, EntityType, UnifiedResult
from menos.services.unified_pipeline import PipelineStageError, UnifiedPipelineService


@pytest.fixture
def mock_settings():
    """Create mock settings for unified pipeline."""
    s = MagicMock()
    s.unified_pipeline_enabled = True
    s.unified_pipeline_max_new_tags = 3
    s.entity_max_topics_per_content = 7
    s.entity_min_confidence = 0.6
    return s


@pytest.fixture
def valid_llm_response():
    """A valid unified JSON response from the LLM."""
    return json.dumps(
        {
            "tags": ["programming", "kubernetes"],
            "new_tags": ["homelab"],
            "tier": "A",
            "tier_explanation": ["Rich technical content", "Relevant to interests"],
            "quality_score": 78,
            "score_explanation": ["Novel approach", "High density"],
            "summary": "A deep dive into Kubernetes.\n\n- Topic 1\n- Topic 2",
            "topics": [
                {
                    "name": "DevOps > Kubernetes > Helm",
                    "confidence": "high",
                    "edge_type": "discusses",
                }
            ],
            "pre_detected_validations": [
                {"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": True}
            ],
            "additional_entities": [
                {"type": "tool", "name": "Helm", "confidence": "medium", "edge_type": "uses"}
            ],
        }
    )


@pytest.fixture
def mock_llm_provider(valid_llm_response):
    """Create mock LLM provider."""
    provider = MagicMock()
    provider.model = "test-model"
    provider.generate = AsyncMock(return_value=valid_llm_response)
    provider.with_context = MagicMock(return_value=provider)
    return provider


@pytest.fixture
def mock_repo():
    """Create mock SurrealDB repository."""
    repo = MagicMock()
    repo.list_tags_with_counts = AsyncMock(
        return_value=[
            {"name": "programming", "count": 10},
            {"name": "kubernetes", "count": 5},
            {"name": "devops", "count": 3},
        ]
    )
    repo.get_topic_hierarchy = AsyncMock(return_value=[])
    repo.get_tag_cooccurrence = AsyncMock(return_value={})
    repo.get_tier_distribution = AsyncMock(return_value={})
    repo.get_tag_aliases = AsyncMock(return_value={})
    repo.record_tag_alias = AsyncMock()
    return repo


@pytest.fixture
def pipeline_service(mock_llm_provider, mock_repo, mock_settings):
    """Create UnifiedPipelineService with mocks."""
    return UnifiedPipelineService(
        llm_provider=mock_llm_provider,
        repo=mock_repo,
        settings=mock_settings,
    )


class TestHappyPath:
    """Test successful unified pipeline processing."""

    @pytest.mark.asyncio
    async def test_returns_unified_result(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert result is not None
        assert isinstance(result, UnifiedResult)

    @pytest.mark.asyncio
    async def test_tags_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert "programming" in result.tags
        assert "kubernetes" in result.tags

    @pytest.mark.asyncio
    async def test_tier_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert result.tier == "A"

    @pytest.mark.asyncio
    async def test_quality_score_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert result.quality_score == 78

    @pytest.mark.asyncio
    async def test_summary_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert "Kubernetes" in result.summary

    @pytest.mark.asyncio
    async def test_topics_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert len(result.topics) >= 1
        assert result.topics[0].entity_type == EntityType.TOPIC
        assert result.topics[0].hierarchy == ["DevOps", "Kubernetes", "Helm"]

    @pytest.mark.asyncio
    async def test_validations_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert len(result.pre_detected_validations) == 1
        assert result.pre_detected_validations[0].entity_id == "entity:langchain"
        assert result.pre_detected_validations[0].edge_type == EdgeType.USES

    @pytest.mark.asyncio
    async def test_additional_entities_parsed(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test Video",
            job_id="test-job",
        )
        assert len(result.additional_entities) == 1
        assert result.additional_entities[0].name == "Helm"
        assert result.additional_entities[0].entity_type == EntityType.TOOL


class TestDisabledSkip:
    """Test that pipeline skips when disabled."""

    @pytest.mark.asyncio
    async def test_returns_none_when_disabled(self, pipeline_service, mock_settings):
        mock_settings.unified_pipeline_enabled = False
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is None


class TestLLMFailure:
    """Test LLM failure handling raises PipelineStageError."""

    @pytest.mark.asyncio
    async def test_llm_error_raises_stage_error(self, pipeline_service, mock_llm_provider):
        mock_llm_provider.generate = AsyncMock(side_effect=RuntimeError("LLM connection failed"))
        with pytest.raises(PipelineStageError) as exc_info:
            await pipeline_service.process(
                content_id="test-1",
                content_text="x" * 1000,
                content_type="youtube",
                title="Test",
                job_id="test-job",
            )
        assert exc_info.value.stage == "llm_call"
        assert exc_info.value.code == "LLM_CALL_ERROR"

    @pytest.mark.asyncio
    async def test_invalid_json_raises_after_retry(self, pipeline_service, mock_llm_provider):
        # Both initial and retry return non-JSON → EMPTY_RESPONSE
        mock_llm_provider.generate = AsyncMock(return_value="not json at all")
        with pytest.raises(PipelineStageError) as exc_info:
            await pipeline_service.process(
                content_id="test-1",
                content_text="x" * 1000,
                content_type="youtube",
                title="Test",
                job_id="test-job",
            )
        assert exc_info.value.stage == "parse"
        assert exc_info.value.code == "EMPTY_RESPONSE"
        # Verify retry was attempted (2 calls: initial + correction)
        assert mock_llm_provider.generate.await_count == 2

    @pytest.mark.asyncio
    async def test_retry_succeeds_with_valid_json(
        self, pipeline_service, mock_llm_provider, valid_llm_response
    ):
        # First call returns markdown, retry returns valid JSON
        mock_llm_provider.generate = AsyncMock(
            side_effect=["**Tags**: python, docker", valid_llm_response]
        )
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is not None
        assert "programming" in result.tags
        assert mock_llm_provider.generate.await_count == 2

    @pytest.mark.asyncio
    async def test_think_block_response_parsed_without_retry(
        self, pipeline_service, mock_llm_provider, valid_llm_response
    ):
        # Think block wrapping valid JSON should parse on first try
        response_with_think = f"<think>\nAnalyzing content...\n</think>\n{valid_llm_response}"
        mock_llm_provider.generate = AsyncMock(return_value=response_with_think)
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is not None
        assert result.tier == "A"
        # No retry needed — parsed on first try
        assert mock_llm_provider.generate.await_count == 1


class TestContentTruncation:
    """Test content truncation for long text."""

    @pytest.mark.asyncio
    async def test_long_content_truncated(self, pipeline_service, mock_llm_provider):
        long_text = "a" * 15000
        await pipeline_service.process(
            content_id="test-1",
            content_text=long_text,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "[Content truncated...]" in prompt
        # Original 15k chars should not all appear
        assert "a" * 15000 not in prompt

    @pytest.mark.asyncio
    async def test_short_content_not_truncated(self, pipeline_service, mock_llm_provider):
        short_text = "a" * 5000
        await pipeline_service.process(
            content_id="test-1",
            content_text=short_text,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "[Content truncated...]" not in prompt


class TestTagDedup:
    """Test tag deduplication in pipeline."""

    @pytest.mark.asyncio
    async def test_near_duplicate_new_tag_mapped(self, pipeline_service, mock_llm_provider):
        mock_llm_provider.generate = AsyncMock(
            return_value=json.dumps(
                {
                    "tags": ["programming"],
                    "new_tags": ["programing"],  # One letter off
                    "tier": "B",
                    "tier_explanation": [],
                    "quality_score": 50,
                    "score_explanation": [],
                    "summary": "",
                    "topics": [],
                    "pre_detected_validations": [],
                    "additional_entities": [],
                }
            )
        )
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is not None
        assert "programming" in result.tags
        assert "programing" not in result.tags


class TestPromptContent:
    """Test that prompt includes required context."""

    @pytest.mark.asyncio
    async def test_prompt_contains_existing_tags(self, pipeline_service, mock_llm_provider):
        await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "programming" in prompt
        assert "kubernetes" in prompt

    @pytest.mark.asyncio
    async def test_prompt_contains_pre_detected(self, pipeline_service, mock_llm_provider):
        mock_entity = MagicMock()
        mock_entity.id = "langchain"
        mock_entity.normalized_name = "langchain"
        mock_entity.entity_type = MagicMock()
        mock_entity.entity_type.value = "tool"
        mock_entity.name = "LangChain"
        pre_detected = [mock_entity]
        await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            pre_detected=pre_detected,
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "LangChain" in prompt

    @pytest.mark.asyncio
    async def test_prompt_contains_existing_topics(self, pipeline_service, mock_llm_provider):
        await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            existing_topics=["AI > LLMs", "DevOps"],
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "AI > LLMs" in prompt
        assert "DevOps" in prompt

    @pytest.mark.asyncio
    async def test_prompt_uses_tags_not_labels(self, pipeline_service, mock_llm_provider):
        await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "tags" in prompt.lower()

    @pytest.mark.asyncio
    async def test_prompt_has_content_delimiters(self, pipeline_service, mock_llm_provider):
        await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        call_args = mock_llm_provider.generate.call_args
        prompt = call_args.args[0]
        assert "<CONTENT>" in prompt
        assert "</CONTENT>" in prompt


class TestShortContentProcessing:
    """Verify unified pipeline has no min-length gate."""

    @pytest.mark.asyncio
    async def test_short_content_not_skipped(self):
        """Content < 500 chars is processed (no min-length gate)."""
        settings = MagicMock()
        settings.unified_pipeline_enabled = True
        settings.unified_pipeline_max_new_tags = 3
        settings.entity_max_topics_per_content = 7
        settings.entity_min_confidence = 0.6

        llm = MagicMock()
        llm.generate = AsyncMock(
            return_value='{"tier": "B", "quality_score": 50, "tags": ["test"], "summary": "Short."}'
        )
        llm.with_context = MagicMock(return_value=llm)
        llm.model = "test-model"

        repo = MagicMock()
        repo.list_tags_with_counts = AsyncMock(return_value=[])
        repo.get_topic_hierarchy = AsyncMock(return_value=[])
        repo.get_tag_cooccurrence = AsyncMock(return_value={})
        repo.get_tier_distribution = AsyncMock(return_value={})
        repo.get_tag_aliases = AsyncMock(return_value={})
        repo.record_tag_alias = AsyncMock()

        service = UnifiedPipelineService(
            llm_provider=llm,
            repo=repo,
            settings=settings,
        )
        result = await service.process(
            content_id="short-1",
            content_text="Hello world!",  # 12 chars, well under 500
            content_type="markdown",
            title="Short",
            job_id="test-job",
        )
        assert result is not None
        llm.generate.assert_called_once()


class TestModelAndTimestamp:
    """Test model name and timestamp recording."""

    @pytest.mark.asyncio
    async def test_model_name_recorded(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is not None
        assert result.model == "test-model"

    @pytest.mark.asyncio
    async def test_processed_at_recorded(self, pipeline_service):
        result = await pipeline_service.process(
            content_id="test-1",
            content_text="x" * 1000,
            content_type="youtube",
            title="Test",
            job_id="test-job",
        )
        assert result is not None
        assert result.processed_at != ""
