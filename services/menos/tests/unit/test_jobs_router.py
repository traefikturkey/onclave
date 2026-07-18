"""Unit tests for jobs router endpoints."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock

import pytest

from menos.config import settings
from menos.models import ContentMetadata, JobStatus, PipelineJob


@pytest.fixture
def sample_content():
    """Create a sample content record."""
    return ContentMetadata(
        id="test-content-1",
        content_type="youtube",
        title="Test Video",
        mime_type="text/plain",
        file_size=1000,
        file_path="youtube/abc/transcript.txt",
        metadata={"video_id": "abc"},
    )


@pytest.fixture
def sample_job():
    """Create a sample pipeline job."""
    return PipelineJob(
        id="job-1",
        resource_key="yt:abc",
        content_id="test-content-1",
        status=JobStatus.PENDING,
        pipeline_version="2.0.0",
        created_at=datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC),
    )


@pytest.fixture
def completed_job():
    """Create a completed pipeline job."""
    return PipelineJob(
        id="job-2",
        resource_key="yt:def",
        content_id="test-content-2",
        status=JobStatus.COMPLETED,
        pipeline_version="2.0.0",
        created_at=datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC),
        started_at=datetime(2026, 1, 15, 12, 0, 1, tzinfo=UTC),
        finished_at=datetime(2026, 1, 15, 12, 0, 5, tzinfo=UTC),
    )


@pytest.fixture
def failed_job():
    """Create a failed pipeline job."""
    return PipelineJob(
        id="job-3",
        resource_key="yt:ghi",
        content_id="test-content-3",
        status=JobStatus.FAILED,
        pipeline_version="2.0.0",
        error_code="PIPELINE_NO_RESULT",
        error_message="Pipeline returned no result",
        created_at=datetime(2026, 1, 15, 12, 0, 0, tzinfo=UTC),
    )


class TestReprocessEndpoint:
    def test_happy_path(
        self, authed_client, mock_surreal_repo, mock_minio_storage, mock_pipeline_orchestrator
    ):
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="youtube",
            title="Video",
            mime_type="text/plain",
            file_size=100,
            file_path="youtube/vid1/transcript.txt",
            metadata={"video_id": "vid1"},
        )
        mock_surreal_repo.db = MagicMock()
        mock_surreal_repo.db.query.return_value = [{"processing_status": None}]
        mock_surreal_repo._parse_query_result.return_value = [{"processing_status": None}]

        mock_minio_storage.download.return_value = b"test transcript"

        submitted_job = PipelineJob(id="new-job", resource_key="yt:vid1", content_id="c1")
        mock_pipeline_orchestrator.submit.return_value = submitted_job

        resp = authed_client.post("/api/v1/content/c1/reprocess")

        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == "new-job"
        assert data["status"] == "submitted"

    def test_content_not_found(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content.return_value = None

        resp = authed_client.post("/api/v1/content/nonexistent/reprocess")

        assert resp.status_code == 404

    def test_already_completed_skips(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="youtube",
            title="Video",
            mime_type="text/plain",
            file_size=100,
            file_path="youtube/vid1/transcript.txt",
        )
        mock_surreal_repo.db = MagicMock()
        mock_surreal_repo.db.query.return_value = [{"processing_status": "completed"}]
        mock_surreal_repo._parse_query_result.return_value = [{"processing_status": "completed"}]

        resp = authed_client.post("/api/v1/content/c1/reprocess")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "already_completed"

    def test_force_reprocesses_completed(
        self, authed_client, mock_surreal_repo, mock_minio_storage, mock_pipeline_orchestrator
    ):
        mock_surreal_repo.get_content.return_value = ContentMetadata(
            id="c1",
            content_type="markdown",
            title="Doc",
            mime_type="text/markdown",
            file_size=100,
            file_path="markdown/c1/doc.md",
        )
        mock_minio_storage.download.return_value = b"# Test doc"

        submitted_job = PipelineJob(id="forced-job", resource_key="cid:c1", content_id="c1")
        mock_pipeline_orchestrator.submit.return_value = submitted_job

        resp = authed_client.post("/api/v1/content/c1/reprocess?force=true")

        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == "forced-job"
        assert data["status"] == "submitted"

    def test_auth_required(self, client):
        resp = client.post("/api/v1/content/c1/reprocess")
        assert resp.status_code == 401


class TestVersionDriftReport:
    def test_report_with_drift(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_version_drift_report = AsyncMock(
            return_value={
                "current_version": "0.5.0",
                "stale_content": [
                    {"version": "0.4.2", "count": 150},
                    {"version": "0.3.1", "count": 12},
                ],
                "total_stale": 162,
                "unknown_version_count": 7,
                "total_content": 500,
            }
        )

        resp = authed_client.get("/api/v1/jobs/drift")

        assert resp.status_code == 200
        data = resp.json()
        assert data["current_version"] == "0.5.0"
        assert data["stale_content"] == [
            {"version": "0.4.2", "count": 150},
            {"version": "0.3.1", "count": 12},
        ]
        assert data["total_stale"] == 162
        assert data["unknown_version_count"] == 7
        assert data["total_content"] == 500
        mock_surreal_repo.get_version_drift_report.assert_awaited_once_with(settings.app_version)

    def test_report_with_no_drift(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_version_drift_report = AsyncMock(
            return_value={
                "current_version": "0.5.0",
                "stale_content": [],
                "total_stale": 0,
                "unknown_version_count": 2,
                "total_content": 23,
            }
        )

        resp = authed_client.get("/api/v1/jobs/drift")

        assert resp.status_code == 200
        data = resp.json()
        assert data["stale_content"] == []
        assert data["total_stale"] == 0
        assert data["unknown_version_count"] == 2
        assert data["total_content"] == 23

    def test_unknown_versions_bucketed_separately(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_version_drift_report = AsyncMock(
            return_value={
                "current_version": "0.5.0",
                "stale_content": [{"version": "0.4.2", "count": 3}],
                "total_stale": 3,
                "unknown_version_count": 11,
                "total_content": 20,
            }
        )

        resp = authed_client.get("/api/v1/jobs/drift")

        assert resp.status_code == 200
        data = resp.json()
        assert data["stale_content"] == [{"version": "0.4.2", "count": 3}]
        assert data["total_stale"] == 3
        assert data["unknown_version_count"] == 11
        assert data["total_content"] == 20

    def test_empty_database(self, authed_client, mock_surreal_repo):
        mock_surreal_repo.get_version_drift_report = AsyncMock(
            return_value={
                "current_version": "0.5.0",
                "stale_content": [],
                "total_stale": 0,
                "unknown_version_count": 0,
                "total_content": 0,
            }
        )

        resp = authed_client.get("/api/v1/jobs/drift")

        assert resp.status_code == 200
        assert resp.json() == {
            "current_version": "0.5.0",
            "stale_content": [],
            "total_stale": 0,
            "unknown_version_count": 0,
            "total_content": 0,
        }

    def test_auth_required(self, client):
        resp = client.get("/api/v1/jobs/drift")
        assert resp.status_code == 401


class TestJobStatus:
    def test_get_by_id(self, authed_client, mock_job_repository, completed_job):
        mock_job_repository.get_job.return_value = completed_job

        resp = authed_client.get("/api/v1/jobs/job-2")

        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == "job-2"
        assert data["status"] == "completed"
        assert "error_code" not in data

    def test_verbose_mode(self, authed_client, mock_job_repository, failed_job):
        mock_job_repository.get_job.return_value = failed_job

        resp = authed_client.get("/api/v1/jobs/job-3?verbose=true")

        assert resp.status_code == 200
        data = resp.json()
        assert data["job_id"] == "job-3"
        assert data["error_code"] == "PIPELINE_NO_RESULT"
        assert data["error_message"] == "Pipeline returned no result"

    def test_not_found(self, authed_client, mock_job_repository):
        mock_job_repository.get_job.return_value = None

        resp = authed_client.get("/api/v1/jobs/nonexistent")

        assert resp.status_code == 404


class TestJobList:
    def test_list_all(self, authed_client, mock_job_repository, sample_job, completed_job):
        mock_job_repository.list_jobs.return_value = ([sample_job, completed_job], 2)

        resp = authed_client.get("/api/v1/jobs")

        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 2
        assert len(data["jobs"]) == 2

    def test_filter_by_status(self, authed_client, mock_job_repository, completed_job):
        mock_job_repository.list_jobs.return_value = ([completed_job], 1)

        resp = authed_client.get("/api/v1/jobs?status=completed")

        assert resp.status_code == 200
        mock_job_repository.list_jobs.assert_called_once_with(
            content_id=None, status=JobStatus.COMPLETED, limit=50, offset=0
        )

    def test_invalid_status(self, authed_client, mock_job_repository):
        resp = authed_client.get("/api/v1/jobs?status=invalid")

        assert resp.status_code == 400

    def test_empty_list(self, authed_client, mock_job_repository):
        mock_job_repository.list_jobs.return_value = ([], 0)

        resp = authed_client.get("/api/v1/jobs")

        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 0
        assert data["jobs"] == []


class TestCancelJob:
    def test_cancel_pending(self, authed_client, mock_job_repository, sample_job):
        mock_job_repository.get_job.return_value = sample_job

        resp = authed_client.post("/api/v1/jobs/job-1/cancel")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"
        mock_job_repository.update_job_status.assert_called_once_with("job-1", JobStatus.CANCELLED)

    def test_cancel_processing(self, authed_client, mock_job_repository):
        processing_job = PipelineJob(
            id="job-4",
            resource_key="yt:xyz",
            content_id="c4",
            status=JobStatus.PROCESSING,
        )
        mock_job_repository.get_job.return_value = processing_job

        resp = authed_client.post("/api/v1/jobs/job-4/cancel")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "cancelled"

    def test_cancel_terminal_noop(self, authed_client, mock_job_repository, completed_job):
        mock_job_repository.get_job.return_value = completed_job

        resp = authed_client.post("/api/v1/jobs/job-2/cancel")

        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert "terminal state" in data["message"]
        mock_job_repository.update_job_status.assert_not_called()

    def test_cancel_not_found(self, authed_client, mock_job_repository):
        mock_job_repository.get_job.return_value = None

        resp = authed_client.post("/api/v1/jobs/nonexistent/cancel")

        assert resp.status_code == 404
