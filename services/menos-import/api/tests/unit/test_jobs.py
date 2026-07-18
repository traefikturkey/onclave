"""Tests for pipeline job models and repository."""

from unittest.mock import MagicMock

import pytest
from surrealdb import RecordID

from menos.models import DataTier, JobStatus, PipelineJob
from menos.services.jobs import JobRepository


class TestJobModels:
    """Test PipelineJob model and enums."""

    def test_pipeline_job_creation_defaults(self):
        """PipelineJob should have sensible defaults."""
        job = PipelineJob(resource_key="yt:abc123", content_id="c1")
        assert job.status == JobStatus.PENDING
        assert job.data_tier == DataTier.COMPACT
        assert job.pipeline_version == ""
        assert job.id is None
        assert job.error_code is None
        assert job.error_message is None
        assert job.error_stage is None
        assert job.metadata == {}

    def test_job_status_enum_values(self):
        """JobStatus enum should have all expected values."""
        assert JobStatus.PENDING == "pending"
        assert JobStatus.PROCESSING == "processing"
        assert JobStatus.COMPLETED == "completed"
        assert JobStatus.FAILED == "failed"
        assert JobStatus.CANCELLED == "cancelled"

    def test_data_tier_enum_values(self):
        """DataTier enum should have compact and full."""
        assert DataTier.COMPACT == "compact"
        assert DataTier.FULL == "full"

    def test_pipeline_job_with_all_fields(self):
        """PipelineJob should accept all optional fields."""
        job = PipelineJob(
            id="job1",
            resource_key="url:abc123",
            content_id="c1",
            status=JobStatus.PROCESSING,
            pipeline_version="1.0.0",
            data_tier=DataTier.FULL,
            error_code="E001",
            error_message="Something failed",
            error_stage="classification",
            metadata={"retry_count": 1},
        )
        assert job.id == "job1"
        assert job.status == JobStatus.PROCESSING
        assert job.data_tier == DataTier.FULL


class TestJobRepositoryCreateJob:
    """Test JobRepository.create_job."""

    @pytest.mark.asyncio
    async def test_create_job(self):
        """create_job should create record and return with ID."""
        mock_db = MagicMock()
        mock_db.create.return_value = [
            {
                "id": "pipeline_job:job1",
                "resource_key": "yt:abc123",
                "content_id": "content:c1",
                "status": "pending",
                "pipeline_version": "1.0.0",
                "data_tier": "compact",
                "created_at": "2026-02-11T00:00:00Z",
            }
        ]

        repo = JobRepository(mock_db)
        job = PipelineJob(
            resource_key="yt:abc123",
            content_id="c1",
            pipeline_version="1.0.0",
        )
        result = await repo.create_job(job)

        assert result.id == "job1"
        assert result.resource_key == "yt:abc123"
        mock_db.create.assert_called_once()


class TestJobRepositoryGetJob:
    """Test JobRepository.get_job."""

    @pytest.mark.asyncio
    async def test_get_job(self):
        """get_job should return PipelineJob for existing ID."""
        mock_db = MagicMock()
        mock_db.select.return_value = [
            {
                "id": "pipeline_job:job1",
                "resource_key": "yt:abc123",
                "content_id": "content:c1",
                "status": "processing",
                "pipeline_version": "1.0.0",
                "data_tier": "compact",
            }
        ]

        repo = JobRepository(mock_db)
        result = await repo.get_job("job1")

        assert result is not None
        assert result.id == "job1"
        assert result.status == JobStatus.PROCESSING
        mock_db.select.assert_called_once_with("pipeline_job:job1")

    @pytest.mark.asyncio
    async def test_get_job_not_found(self):
        """get_job should return None when job doesn't exist."""
        mock_db = MagicMock()
        mock_db.select.return_value = []

        repo = JobRepository(mock_db)
        result = await repo.get_job("nonexistent")

        assert result is None


class TestJobRepositoryFindActiveJob:
    """Test JobRepository.find_active_job_by_resource_key."""

    @pytest.mark.asyncio
    async def test_find_active_job_by_resource_key(self):
        """Should find pending/processing jobs by resource key."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "pending",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                    }
                ]
            }
        ]

        repo = JobRepository(mock_db)
        result = await repo.find_active_job_by_resource_key("yt:abc123")

        assert result is not None
        assert result.resource_key == "yt:abc123"
        assert result.status == JobStatus.PENDING

    @pytest.mark.asyncio
    async def test_find_active_job_no_match(self):
        """Should return None when no active job exists."""
        mock_db = MagicMock()
        mock_db.query.return_value = [{"result": []}]

        repo = JobRepository(mock_db)
        result = await repo.find_active_job_by_resource_key("yt:missing")

        assert result is None


class TestJobRepositoryUpdateStatus:
    """Test JobRepository.update_job_status."""

    @pytest.mark.asyncio
    async def test_update_job_status(self):
        """Should transition job state and set timestamps."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "processing",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                        "started_at": "2026-02-11T00:00:00Z",
                    }
                ]
            }
        ]

        repo = JobRepository(mock_db)
        result = await repo.update_job_status("job1", JobStatus.PROCESSING)

        assert result is not None
        assert result.status == JobStatus.PROCESSING
        call_args = mock_db.query.call_args[0]
        assert "started_at" in call_args[0]

    @pytest.mark.asyncio
    async def test_update_job_status_with_error(self):
        """Should set error fields on failure."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "failed",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                        "error_code": "E001",
                        "error_message": "LLM timeout",
                        "error_stage": "classification",
                        "finished_at": "2026-02-11T00:01:00Z",
                    }
                ]
            }
        ]

        repo = JobRepository(mock_db)
        result = await repo.update_job_status(
            "job1",
            JobStatus.FAILED,
            error_code="E001",
            error_message="LLM timeout",
            error_stage="classification",
        )

        assert result is not None
        assert result.status == JobStatus.FAILED
        assert result.error_code == "E001"
        assert result.error_message == "LLM timeout"
        assert result.error_stage == "classification"
        call_args = mock_db.query.call_args[0]
        assert "finished_at" in call_args[0]
        assert "error_code" in call_args[0]


class TestJobRepositoryListJobs:
    """Test JobRepository.list_jobs."""

    @pytest.mark.asyncio
    async def test_list_jobs_no_filter(self):
        """Should return all jobs when no filter is applied."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "completed",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                    },
                    {
                        "id": "pipeline_job:job2",
                        "resource_key": "url:def456",
                        "content_id": "content:c2",
                        "status": "pending",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                    },
                ]
            }
        ]

        repo = JobRepository(mock_db)
        jobs, total = await repo.list_jobs()

        assert len(jobs) == 2
        assert total == 2

    @pytest.mark.asyncio
    async def test_list_jobs_filter_by_status(self):
        """Should filter jobs by status."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "pending",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                    }
                ]
            }
        ]

        repo = JobRepository(mock_db)
        jobs, total = await repo.list_jobs(status=JobStatus.PENDING)

        assert len(jobs) == 1
        call_args = mock_db.query.call_args[0]
        assert "status = $status" in call_args[0]
        assert call_args[1]["status"] == "pending"

    @pytest.mark.asyncio
    async def test_list_jobs_filter_by_content_id(self):
        """Should filter jobs by content_id."""
        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {
                        "id": "pipeline_job:job1",
                        "resource_key": "yt:abc123",
                        "content_id": "content:c1",
                        "status": "completed",
                        "pipeline_version": "1.0.0",
                        "data_tier": "compact",
                    }
                ]
            }
        ]

        repo = JobRepository(mock_db)
        jobs, total = await repo.list_jobs(content_id="c1")

        assert len(jobs) == 1
        call_args = mock_db.query.call_args[0]
        assert "content_id = $content_id" in call_args[0]
        assert call_args[1]["content_id"] == RecordID("content", "c1")
