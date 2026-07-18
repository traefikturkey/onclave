"""Pipeline job management and content reprocessing endpoints."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from menos.auth.dependencies import AuthenticatedKeyId
from menos.config import settings
from menos.models import JobStatus
from menos.services.di import (
    get_job_repository,
    get_minio_storage,
    get_pipeline_orchestrator,
    get_surreal_repo,
)
from menos.services.jobs import JobRepository
from menos.services.pipeline_orchestrator import PipelineOrchestrator
from menos.services.resource_key import generate_resource_key
from menos.services.storage import MinIOStorage, SurrealDBRepository

logger = logging.getLogger(__name__)

content_router = APIRouter(prefix="/content", tags=["pipeline"])
jobs_router = APIRouter(prefix="/jobs", tags=["jobs"])


# -- Response models --


class ReprocessResponse(BaseModel):
    """Response after submitting content for reprocessing."""

    job_id: str | None = None
    content_id: str
    status: str  # "submitted" | "already_active" | "already_completed"


class JobStatusResponse(BaseModel):
    """Minimal job status response."""

    job_id: str
    content_id: str
    status: str
    created_at: str | None = None
    started_at: str | None = None
    finished_at: str | None = None


class JobDetailResponse(JobStatusResponse):
    """Verbose job details including error info and metadata."""

    error_code: str | None = None
    error_message: str | None = None
    error_stage: str | None = None
    resource_key: str | None = None
    pipeline_version: str | None = None
    metadata: dict | None = None


class JobListResponse(BaseModel):
    """List of jobs with total count."""

    jobs: list[JobStatusResponse]
    total: int


class CancelResponse(BaseModel):
    """Response after cancelling a job."""

    job_id: str
    status: str
    message: str


class VersionCount(BaseModel):
    """Count of completed content items by pipeline version."""

    version: str
    count: int


class DriftReportResponse(BaseModel):
    """Version drift report for completed content."""

    current_version: str
    stale_content: list[VersionCount]
    total_stale: int
    unknown_version_count: int
    total_content: int


# -- Reprocess endpoint --


def _already_completed(content_id: str, surreal_repo: SurrealDBRepository) -> bool:
    """Return True if content processing_status is 'completed'."""
    raw = surreal_repo.db.query(
        "SELECT processing_status FROM content WHERE id = $id",
        {"id": content_id},
    )
    parsed = surreal_repo._parse_query_result(raw)
    return bool(parsed and parsed[0].get("processing_status") == "completed")


def _resolve_resource_key(content, content_id: str) -> str:
    """Generate the resource key for content reprocessing."""
    video_id = content.metadata.get("video_id") if content.metadata else None
    if content.content_type == "youtube" and video_id:
        return generate_resource_key("youtube", video_id)
    return generate_resource_key(content.content_type, content_id)


@content_router.post("/{content_id}/reprocess", response_model=ReprocessResponse)
async def reprocess_content(
    content_id: str,
    key_id: AuthenticatedKeyId,
    force: bool = Query(default=False, description="Force reprocessing even if completed"),
    orchestrator: PipelineOrchestrator = Depends(get_pipeline_orchestrator),
    minio_storage: MinIOStorage = Depends(get_minio_storage),
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Reprocess content through the unified pipeline."""
    content = await surreal_repo.get_content(content_id)
    if not content:
        raise HTTPException(status_code=404, detail="Content not found")

    logger.info(
        "audit.reprocess_trigger content_id=%s force=%s key_id=%s", content_id, force, key_id
    )

    if not force and _already_completed(content_id, surreal_repo):
        return ReprocessResponse(content_id=content_id, status="already_completed")

    try:
        content_bytes = await minio_storage.download(content.file_path)
        content_text = content_bytes.decode("utf-8")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to download content: {e}") from e

    resource_key = _resolve_resource_key(content, content_id)
    job = await orchestrator.submit(
        content_id, content_text, content.content_type, content.title or "Untitled", resource_key
    )

    return ReprocessResponse(
        job_id=job.id if job else None,
        content_id=content_id,
        status="submitted",
    )


# -- Job management endpoints --


def _parse_stale_content(report: dict) -> list[VersionCount]:
    """Extract and parse stale_content rows from a drift report dict."""
    rows = report.get("stale_content") if isinstance(report, dict) else []
    result = []
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict):
            result.append(
                VersionCount(
                    version=str(row.get("version") or ""),
                    count=int(row.get("count") or 0),
                )
            )
    return result


@jobs_router.get("/drift", response_model=DriftReportResponse)
async def get_jobs_drift_report(
    key_id: AuthenticatedKeyId,
    surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
):
    """Get version drift report for completed content."""
    del key_id
    report = await surreal_repo.get_version_drift_report(settings.app_version)
    if not isinstance(report, dict):
        report = {}
    return DriftReportResponse(
        current_version=str(report.get("current_version") or settings.app_version),
        stale_content=_parse_stale_content(report),
        total_stale=int(report.get("total_stale") or 0),
        unknown_version_count=int(report.get("unknown_version_count") or 0),
        total_content=int(report.get("total_content") or 0),
    )


def _job_status_response(job, job_id: str) -> JobStatusResponse:
    return JobStatusResponse(
        job_id=job.id or job_id,
        content_id=job.content_id,
        status=job.status.value,
        created_at=job.created_at.isoformat() if job.created_at else None,
        started_at=job.started_at.isoformat() if job.started_at else None,
        finished_at=job.finished_at.isoformat() if job.finished_at else None,
    )


def _job_detail_response(job, job_id: str) -> JobDetailResponse:
    return JobDetailResponse(
        job_id=job.id or job_id,
        content_id=job.content_id,
        status=job.status.value,
        created_at=job.created_at.isoformat() if job.created_at else None,
        started_at=job.started_at.isoformat() if job.started_at else None,
        finished_at=job.finished_at.isoformat() if job.finished_at else None,
        error_code=job.error_code,
        error_message=job.error_message,
        error_stage=job.error_stage,
        resource_key=job.resource_key,
        pipeline_version=job.pipeline_version,
        metadata=job.metadata,
    )


@jobs_router.get("/{job_id}")
async def get_job_status(
    job_id: str,
    key_id: AuthenticatedKeyId,
    verbose: bool = Query(default=False, description="Include full job details"),
    job_repo: JobRepository = Depends(get_job_repository),
):
    """Get pipeline job status by ID."""
    job = await job_repo.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if verbose:
        logger.info("audit.full_tier_access job_id=%s key_id=%s", job_id, key_id)
        return _job_detail_response(job, job_id)

    return _job_status_response(job, job_id)


@jobs_router.get("", response_model=JobListResponse)
async def list_jobs(
    key_id: AuthenticatedKeyId,
    content_id: str | None = Query(default=None, description="Filter by content ID"),
    status: str | None = Query(default=None, description="Filter by status"),
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    job_repo: JobRepository = Depends(get_job_repository),
):
    """List pipeline jobs with optional filters."""
    status_enum = None
    if status:
        try:
            status_enum = JobStatus(status)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status: {status}. Valid: {', '.join(s.value for s in JobStatus)}",
            )

    jobs, total = await job_repo.list_jobs(
        content_id=content_id,
        status=status_enum,
        limit=limit,
        offset=offset,
    )

    return JobListResponse(
        jobs=[
            JobStatusResponse(
                job_id=j.id or "",
                content_id=j.content_id,
                status=j.status.value,
                created_at=j.created_at.isoformat() if j.created_at else None,
                started_at=j.started_at.isoformat() if j.started_at else None,
                finished_at=j.finished_at.isoformat() if j.finished_at else None,
            )
            for j in jobs
        ],
        total=total,
    )


@jobs_router.post("/{job_id}/cancel", response_model=CancelResponse)
async def cancel_job(
    job_id: str,
    key_id: AuthenticatedKeyId,
    job_repo: JobRepository = Depends(get_job_repository),
):
    """Cancel a pipeline job.

    - pending: immediately cancelled
    - processing: best-effort cancel (checked before pipeline runs)
    - terminal states: no-op, returns current status
    """
    job = await job_repo.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if job.status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED):
        logger.info(
            "audit.cancellation job_id=%s outcome=already_%s key_id=%s",
            job.id or job_id,
            job.status.value,
            key_id,
        )
        return CancelResponse(
            job_id=job.id or job_id,
            status=job.status.value,
            message=f"Job already in terminal state: {job.status.value}",
        )

    await job_repo.update_job_status(job.id or job_id, JobStatus.CANCELLED)

    logger.info(
        "audit.cancellation job_id=%s outcome=cancelled key_id=%s",
        job.id or job_id,
        key_id,
    )

    return CancelResponse(
        job_id=job.id or job_id,
        status="cancelled",
        message="Job cancelled",
    )
