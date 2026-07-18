"""Tests for pipeline observability: correlation IDs, error taxonomy, audit events."""

import logging
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.models import JobStatus, PipelineJob
from menos.services.unified_pipeline import PipelineStageError, UnifiedPipelineService


class TestPipelineStageError:
    def test_stage_error_carries_fields(self):
        err = PipelineStageError("llm_call", "LLM_TIMEOUT", "Request timed out")
        assert err.stage == "llm_call"
        assert err.code == "LLM_TIMEOUT"
        assert err.message == "Request timed out"
        assert "llm_call" in str(err)

    def test_stage_error_is_exception(self):
        err = PipelineStageError("parse", "PARSE_FAILED", "bad json")
        assert isinstance(err, Exception)


class TestJobIdCorrelation:
    @pytest.fixture
    def pipeline_service(self):
        settings = MagicMock()
        settings.unified_pipeline_enabled = True
        settings.unified_pipeline_max_new_tags = 3
        settings.entity_max_topics_per_content = 7
        settings.entity_min_confidence = 0.6
        llm = MagicMock()
        llm.generate = AsyncMock(
            return_value='{"tier": "B", "quality_score": 50, "tags": ["test"]}'
        )
        llm.with_context = MagicMock(return_value=llm)
        llm.model = "test-model"
        repo = MagicMock()
        repo.list_tags_with_counts = AsyncMock(return_value=[{"name": "existing"}])
        repo.get_topic_hierarchy = AsyncMock(return_value=[])
        repo.get_tag_cooccurrence = AsyncMock(return_value={})
        repo.get_tier_distribution = AsyncMock(return_value={})
        repo.get_tag_aliases = AsyncMock(return_value={})
        repo.record_tag_alias = AsyncMock()
        return UnifiedPipelineService(
            llm_provider=llm,
            repo=repo,
            settings=settings,
        )

    @pytest.mark.asyncio
    async def test_process_logs_job_id(self, pipeline_service, caplog):
        with caplog.at_level(logging.INFO, logger="menos.services.unified_pipeline"):
            await pipeline_service.process(
                content_id="test-123",
                content_text="Hello world content for testing",
                content_type="markdown",
                title="Test",
                job_id="job-abc",
            )
        assert any("job-abc" in record.message for record in caplog.records)

    @pytest.mark.asyncio
    async def test_process_without_job_id(self, pipeline_service, caplog):
        with caplog.at_level(logging.INFO, logger="menos.services.unified_pipeline"):
            await pipeline_service.process(
                content_id="test-123",
                content_text="Hello world content for testing",
                content_type="markdown",
                title="Test",
            )
        # Should still work with job_id=None
        assert any("stage.llm_call" in record.message for record in caplog.records)


class TestOrchestratorErrorStage:
    @pytest.fixture
    def orchestrator_deps(self):
        settings = MagicMock()
        settings.unified_pipeline_enabled = True
        settings.unified_pipeline_max_concurrency = 4
        settings.app_version = "1.0.0"

        pipeline_service = MagicMock()
        job_repo = MagicMock()
        job_repo.get_job = AsyncMock(
            return_value=PipelineJob(
                id="job-1",
                resource_key="test:key",
                content_id="c1",
                status=JobStatus.PENDING,
            )
        )
        job_repo.update_job_status = AsyncMock(return_value=None)
        surreal_repo = MagicMock()
        surreal_repo.update_content_processing_status = AsyncMock()
        callback_service = None

        return pipeline_service, job_repo, surreal_repo, settings, callback_service

    @pytest.mark.asyncio
    async def test_pipeline_stage_error_populates_error_stage(self, orchestrator_deps):
        from menos.services.pipeline_orchestrator import PipelineOrchestrator

        pipeline_service, job_repo, surreal_repo, settings, callback_service = orchestrator_deps
        pipeline_service.process = AsyncMock(
            side_effect=PipelineStageError("llm_call", "LLM_TIMEOUT", "timed out")
        )

        orch = PipelineOrchestrator(
            pipeline_service,
            job_repo,
            surreal_repo,
            settings,
            callback_service,
        )
        job = PipelineJob(id="job-1", resource_key="test:key", content_id="c1")

        await orch._run_pipeline(job, "text", "markdown", "title")

        job_repo.update_job_status.assert_any_call(
            "job-1",
            JobStatus.FAILED,
            error_code="LLM_TIMEOUT",
            error_message="timed out",
            error_stage="llm_call",
        )

    @pytest.mark.asyncio
    async def test_generic_exception_sets_unknown_stage(self, orchestrator_deps):
        from menos.services.pipeline_orchestrator import PipelineOrchestrator

        pipeline_service, job_repo, surreal_repo, settings, callback_service = orchestrator_deps
        pipeline_service.process = AsyncMock(side_effect=RuntimeError("boom"))

        orch = PipelineOrchestrator(
            pipeline_service,
            job_repo,
            surreal_repo,
            settings,
            callback_service,
        )
        job = PipelineJob(id="job-1", resource_key="test:key", content_id="c1")

        await orch._run_pipeline(job, "text", "markdown", "title")

        job_repo.update_job_status.assert_any_call(
            "job-1",
            JobStatus.FAILED,
            error_code="PIPELINE_EXCEPTION",
            error_message="boom",
            error_stage="unknown",
        )
