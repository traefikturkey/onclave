"""Unit tests for PipelineOrchestrator."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from menos.models import JobStatus, PipelineJob
from menos.services.pipeline_orchestrator import PipelineOrchestrator
from menos.services.unified_pipeline import PipelineStageError


@pytest.fixture(autouse=True)
def reset_semaphore():
    """Reset module-level semaphore between tests."""
    with patch("menos.services.pipeline_orchestrator._semaphore", None):
        yield


@pytest.fixture
def mock_pipeline_service():
    service = MagicMock()
    service.process = AsyncMock(return_value=None)
    return service


@pytest.fixture
def mock_job_repo():
    repo = MagicMock()
    repo.create_job = AsyncMock()
    repo.get_job = AsyncMock(return_value=None)
    repo.find_active_job_by_resource_key = AsyncMock(return_value=None)
    repo.update_job_status = AsyncMock()
    repo.list_jobs = AsyncMock(return_value=([], 0))
    return repo


@pytest.fixture
def mock_surreal_repo():
    repo = MagicMock()
    repo.update_content_processing_status = AsyncMock()
    repo.update_content_processing_result = AsyncMock()
    return repo


@pytest.fixture
def mock_settings():
    s = MagicMock()
    s.unified_pipeline_enabled = True
    s.unified_pipeline_max_concurrency = 4
    s.app_version = "1.0.0"
    return s


@pytest.fixture
def orchestrator(mock_pipeline_service, mock_job_repo, mock_surreal_repo, mock_settings):
    return PipelineOrchestrator(
        pipeline_service=mock_pipeline_service,
        job_repo=mock_job_repo,
        surreal_repo=mock_surreal_repo,
        settings=mock_settings,
    )


class TestSubmitHappyPath:
    @pytest.mark.asyncio
    async def test_creates_job_and_returns_it(self, orchestrator, mock_job_repo):
        created_job = PipelineJob(
            id="job1",
            resource_key="yt:abc",
            content_id="abc",
            pipeline_version="1.0.0",
        )
        mock_job_repo.create_job.return_value = created_job

        result = await orchestrator.submit("abc", "text", "youtube", "Title", "yt:abc")

        assert result is not None
        assert result.id == "job1"
        mock_job_repo.create_job.assert_called_once()

    @pytest.mark.asyncio
    async def test_sets_pending_status(self, orchestrator, mock_job_repo, mock_surreal_repo):
        created_job = PipelineJob(
            id="job1",
            resource_key="yt:abc",
            content_id="abc",
            pipeline_version="1.0.0",
        )
        mock_job_repo.create_job.return_value = created_job

        await orchestrator.submit("abc", "text", "youtube", "Title", "yt:abc")

        mock_surreal_repo.update_content_processing_status.assert_called_once_with(
            "abc", "pending", pipeline_version="1.0.0"
        )


class TestSubmitIdempotency:
    @pytest.mark.asyncio
    async def test_returns_existing_active_job(self, orchestrator, mock_job_repo):
        existing = PipelineJob(
            id="existing1",
            resource_key="yt:abc",
            content_id="abc",
            status=JobStatus.PROCESSING,
        )
        mock_job_repo.find_active_job_by_resource_key.return_value = existing

        result = await orchestrator.submit("abc", "text", "youtube", "Title", "yt:abc")

        assert result.id == "existing1"
        mock_job_repo.create_job.assert_not_called()


class TestSubmitDisabled:
    @pytest.mark.asyncio
    async def test_returns_none_when_disabled(self, orchestrator, mock_settings):
        mock_settings.unified_pipeline_enabled = False

        result = await orchestrator.submit("abc", "text", "youtube", "Title", "yt:abc")

        assert result is None


class TestRunPipeline:
    @pytest.mark.asyncio
    async def test_completes_successfully(
        self, orchestrator, mock_pipeline_service, mock_job_repo, mock_surreal_repo
    ):
        mock_result = MagicMock()
        mock_result.model_dump.return_value = {"tier": "A", "quality_score": 80}
        mock_pipeline_service.process.return_value = mock_result

        job = PipelineJob(id="job1", resource_key="yt:abc", content_id="abc")

        await orchestrator._run_pipeline(job, "text", "youtube", "Title")

        mock_job_repo.update_job_status.assert_any_call("job1", JobStatus.PROCESSING)
        mock_job_repo.update_job_status.assert_any_call("job1", JobStatus.COMPLETED)
        mock_surreal_repo.update_content_processing_result.assert_called_once()


class TestRunPipelineFailure:
    @pytest.mark.asyncio
    async def test_none_result_marks_failed(
        self, orchestrator, mock_pipeline_service, mock_job_repo
    ):
        mock_pipeline_service.process.return_value = None
        job = PipelineJob(id="job1", resource_key="yt:abc", content_id="abc")

        await orchestrator._run_pipeline(job, "text", "youtube", "Title")

        mock_job_repo.update_job_status.assert_any_call(
            "job1",
            JobStatus.FAILED,
            error_code="PIPELINE_NO_RESULT",
            error_message="Pipeline returned no result",
        )


class TestRunPipelineException:
    @pytest.mark.asyncio
    async def test_exception_marks_failed_with_unknown_stage(
        self,
        orchestrator,
        mock_pipeline_service,
        mock_job_repo,
    ):
        mock_pipeline_service.process.side_effect = RuntimeError("LLM down")
        job = PipelineJob(id="job1", resource_key="yt:abc", content_id="abc")

        await orchestrator._run_pipeline(job, "text", "youtube", "Title")

        mock_job_repo.update_job_status.assert_any_call(
            "job1",
            JobStatus.FAILED,
            error_code="PIPELINE_EXCEPTION",
            error_message="LLM down",
            error_stage="unknown",
        )


class TestRunPipelineStageError:
    @pytest.mark.asyncio
    async def test_stage_error_populates_error_stage(
        self,
        orchestrator,
        mock_pipeline_service,
        mock_job_repo,
    ):
        mock_pipeline_service.process.side_effect = PipelineStageError(
            "llm_call",
            "LLM_TIMEOUT",
            "timed out",
        )
        job = PipelineJob(id="job1", resource_key="yt:abc", content_id="abc")

        await orchestrator._run_pipeline(job, "text", "youtube", "Title")

        mock_job_repo.update_job_status.assert_any_call(
            "job1",
            JobStatus.FAILED,
            error_code="LLM_TIMEOUT",
            error_message="timed out",
            error_stage="llm_call",
        )


class TestRunPipelineCancellation:
    @pytest.mark.asyncio
    async def test_cancelled_job_skips_processing(
        self, orchestrator, mock_job_repo, mock_pipeline_service
    ):
        cancelled_job = PipelineJob(
            id="job1",
            resource_key="yt:abc",
            content_id="abc",
            status=JobStatus.CANCELLED,
        )
        mock_job_repo.get_job.return_value = cancelled_job

        job = PipelineJob(id="job1", resource_key="yt:abc", content_id="abc")
        await orchestrator._run_pipeline(job, "text", "youtube", "Title")

        mock_pipeline_service.process.assert_not_called()
