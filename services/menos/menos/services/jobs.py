"""Pipeline job repository for the job-first authority model."""

# ruff: noqa: E501

from datetime import UTC, datetime
from uuid import uuid4

from menos.models import JobStatus, PipelineJob
from menos.services.storage import PostgresRepository


class JobRepository:
    def __init__(self, repository: PostgresRepository):
        self._repository = repository

    async def create_job(self, job: PipelineJob) -> PipelineJob:
        job.id = job.id or uuid4().hex
        job.created_at = job.created_at or datetime.now(UTC)
        row = self._repository.create_pipeline_job(job)
        return PipelineJob(**(row or job.model_dump()))

    async def get_job(self, job_id: str) -> PipelineJob | None:
        row = self._repository.get_pipeline_job(job_id)
        return PipelineJob(**row) if row else None

    async def find_active_job_by_resource_key(self, resource_key: str) -> PipelineJob | None:
        row = self._repository.find_active_pipeline_job(resource_key)
        return PipelineJob(**row) if row else None

    async def update_job_status(
        self,
        job_id: str,
        status: JobStatus,
        error_code: str | None = None,
        error_message: str | None = None,
        error_stage: str | None = None,
    ) -> PipelineJob | None:
        started = datetime.now(UTC) if status == JobStatus.PROCESSING else None
        finished = (
            datetime.now(UTC)
            if status in {JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED}
            else None
        )
        row = self._repository.update_pipeline_job(
            job_id,
            status,
            (started, finished),
            (error_code, error_message, error_stage),
        )
        return PipelineJob(**row) if row else None

    async def list_jobs(
        self,
        content_id: str | None = None,
        status: JobStatus | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[PipelineJob], int]:
        self._validate_pagination(limit, offset)
        rows, total = self._repository.list_pipeline_jobs(content_id, status, limit, offset)
        return [PipelineJob(**row) for row in rows], total

    @staticmethod
    def _validate_pagination(limit: int, offset: int) -> None:
        if limit < 1 or limit > 1000 or offset < 0:
            raise ValueError("invalid job pagination")
