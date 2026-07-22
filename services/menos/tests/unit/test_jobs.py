"""Tests for PostgreSQL pipeline job models and repository."""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest

from menos.models import DataTier, JobStatus, PipelineJob
from menos.services.jobs import JobRepository


def _row(**overrides):
    row = {
        "id": "job1",
        "resource_key": "yt:abc123",
        "content_id": "c1",
        "status": "pending",
        "pipeline_version": "1.0.0",
        "data_tier": "compact",
        "metadata": {},
        "created_at": datetime.now(UTC),
        "started_at": None,
        "finished_at": None,
        "error_code": None,
        "error_message": None,
        "error_stage": None,
    }
    row.update(overrides)
    return row


@pytest.fixture
def repository():
    return MagicMock()


def test_pipeline_job_defaults():
    job = PipelineJob(resource_key="yt:abc123", content_id="c1")
    assert job.status == JobStatus.PENDING
    assert job.data_tier == DataTier.COMPACT
    assert job.metadata == {}


@pytest.mark.asyncio
async def test_create_job_uses_postgres_repository(repository):
    repository.create_pipeline_job.return_value = _row()
    result = await JobRepository(repository).create_job(
        PipelineJob(resource_key="yt:abc123", content_id="c1", pipeline_version="1.0.0")
    )
    assert result.id == "job1"
    repository.create_pipeline_job.assert_called_once()


@pytest.mark.asyncio
async def test_get_and_find_active_job(repository):
    repository.get_pipeline_job.return_value = _row(status="processing")
    repository.find_active_pipeline_job.return_value = _row()
    jobs = JobRepository(repository)
    assert (await jobs.get_job("job1")).status == JobStatus.PROCESSING
    assert (await jobs.find_active_job_by_resource_key("yt:abc123")).id == "job1"


@pytest.mark.asyncio
async def test_update_job_status_sets_terminal_fields(repository):
    repository.update_pipeline_job.return_value = _row(
        status="failed", error_code="E001", finished_at=datetime.now(UTC)
    )
    result = await JobRepository(repository).update_job_status(
        "job1", JobStatus.FAILED, error_code="E001"
    )
    assert result.status == JobStatus.FAILED
    assert result.error_code == "E001"
    assert result.finished_at is not None


@pytest.mark.asyncio
async def test_list_jobs_preserves_total_and_ordering(repository):
    repository.list_pipeline_jobs.return_value = ([_row(), _row(id="job2")], 2)
    rows, total = await JobRepository(repository).list_jobs(limit=10)
    assert [row.id for row in rows] == ["job1", "job2"]
    assert total == 2
    repository.list_pipeline_jobs.assert_called_once_with(None, None, 10, 0)


@pytest.mark.asyncio
async def test_list_jobs_rejects_unbounded_limit(repository):
    with pytest.raises(ValueError, match="pagination"):
        await JobRepository(repository).list_jobs(limit=1001)
