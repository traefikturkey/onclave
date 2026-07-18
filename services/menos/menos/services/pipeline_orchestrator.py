"""Pipeline orchestrator for unified content processing."""

import asyncio
import logging

from menos.config import Settings
from menos.models import JobStatus, PipelineJob
from menos.services.callbacks import CallbackService
from menos.services.jobs import JobRepository
from menos.services.storage import SurrealDBRepository
from menos.services.unified_pipeline import PipelineStageError, UnifiedPipelineService
from menos.tasks import background_tasks

logger = logging.getLogger(__name__)

_semaphore: asyncio.Semaphore | None = None


def _get_semaphore(max_concurrency: int) -> asyncio.Semaphore:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(max_concurrency)
    return _semaphore


class PipelineOrchestrator:
    """Orchestrates unified pipeline processing with job tracking."""

    def __init__(
        self,
        pipeline_service: UnifiedPipelineService,
        job_repo: JobRepository,
        surreal_repo: SurrealDBRepository,
        settings: Settings,
        callback_service: CallbackService | None = None,
    ):
        self.pipeline_service = pipeline_service
        self.job_repo = job_repo
        self.surreal_repo = surreal_repo
        self.settings = settings
        self.callback_service = callback_service

    async def submit(
        self,
        content_id: str,
        content_text: str,
        content_type: str,
        title: str,
        resource_key: str,
    ) -> PipelineJob | None:
        """Submit content for pipeline processing.

        Args:
            content_id: Content ID
            content_text: Full content text
            content_type: Type of content (youtube, markdown, etc.)
            title: Content title
            resource_key: Canonical resource key for deduplication

        Returns:
            PipelineJob or None if pipeline disabled
        """
        if not self.settings.unified_pipeline_enabled:
            logger.debug("Unified pipeline disabled, skipping %s", content_id)
            return None

        # Check for existing active job (idempotency)
        existing = await self.job_repo.find_active_job_by_resource_key(resource_key)
        if existing:
            logger.info("Active job %s already exists for %s", existing.id, resource_key)
            return existing

        # Create new job
        job = PipelineJob(
            resource_key=resource_key,
            content_id=content_id,
            pipeline_version=self.settings.app_version,
        )
        job = await self.job_repo.create_job(job)

        # Set content processing status to pending
        await self.surreal_repo.update_content_processing_status(
            content_id, "pending", pipeline_version=self.settings.app_version
        )

        # Launch background task
        task = asyncio.create_task(self._run_pipeline(job, content_text, content_type, title))
        background_tasks.add(task)
        task.add_done_callback(background_tasks.discard)

        return job

    async def _mark_failed(self, job_id: str, content_id: str, **kwargs) -> None:
        """Best-effort: mark job and content as failed. Swallows secondary errors."""
        try:
            await self.job_repo.update_job_status(job_id, JobStatus.FAILED, **kwargs)
            await self.surreal_repo.update_content_processing_status(content_id, "failed")
        except Exception as inner_e:
            logger.error("Failed to update job status for %s: %s", job_id, inner_e)

    async def _handle_result(self, job: PipelineJob, job_id: str, content_id: str, result) -> None:
        """Persist a successful pipeline result and fire the callback."""
        result_dict = result.model_dump(mode="json")
        await self.surreal_repo.update_content_processing_result(
            content_id, result_dict, self.settings.app_version
        )
        updated_job = await self.job_repo.update_job_status(job_id, JobStatus.COMPLETED)
        logger.info("Pipeline completed for job %s", job_id)
        await self._fire_callback(updated_job or job, result_dict)

    async def _handle_no_result(self, job: PipelineJob, job_id: str, content_id: str) -> None:
        """Handle a pipeline run that returned no result."""
        updated_job = await self.job_repo.update_job_status(
            job_id,
            JobStatus.FAILED,
            error_code="PIPELINE_NO_RESULT",
            error_message="Pipeline returned no result",
        )
        await self.surreal_repo.update_content_processing_status(content_id, "failed")
        logger.warning("Pipeline returned no result for job %s", job_id)
        await self._fire_callback(updated_job or job)

    async def _execute_pipeline(
        self,
        job: PipelineJob,
        job_id: str,
        content_id: str,
        content_text: str,
        content_type: str,
        title: str,
    ) -> None:
        """Run pipeline inside the semaphore (already held by caller)."""
        current_job = await self.job_repo.get_job(job_id)
        if current_job and current_job.status == JobStatus.CANCELLED:
            logger.info("Job %s was cancelled before processing", job_id)
            return
        await self.job_repo.update_job_status(job_id, JobStatus.PROCESSING)
        await self.surreal_repo.update_content_processing_status(content_id, "processing")
        result = await self.pipeline_service.process(
            content_id=content_id,
            content_text=content_text,
            content_type=content_type,
            title=title,
            job_id=job_id,
        )
        if result:
            await self._handle_result(job, job_id, content_id, result)
        else:
            await self._handle_no_result(job, job_id, content_id)

    async def _run_pipeline(
        self,
        job: PipelineJob,
        content_text: str,
        content_type: str,
        title: str,
    ) -> None:
        """Run the unified pipeline for a job."""
        job_id = job.id or ""
        content_id = job.content_id
        sem = _get_semaphore(self.settings.unified_pipeline_max_concurrency)
        try:
            async with sem:
                await self._execute_pipeline(
                    job, job_id, content_id, content_text, content_type, title
                )
        except asyncio.CancelledError:
            logger.warning("Pipeline cancelled for job %s (shutdown?)", job_id)
            try:
                await self.job_repo.update_job_status(job_id, JobStatus.CANCELLED)
                await self.surreal_repo.update_content_processing_status(content_id, "failed")
            except Exception:
                pass
            raise
        except PipelineStageError as e:
            logger.error("Pipeline stage error for job %s: %s", job_id, e, exc_info=True)
            await self._mark_failed(
                job_id,
                content_id,
                error_code=e.code,
                error_message=e.message[:500],
                error_stage=e.stage,
            )
        except Exception as e:
            logger.error("Pipeline failed for job %s: %s", job_id, e, exc_info=True)
            await self._mark_failed(
                job_id,
                content_id,
                error_code="PIPELINE_EXCEPTION",
                error_message=str(e)[:500],
                error_stage="unknown",
            )

    async def _fire_callback(
        self,
        job: PipelineJob,
        result_dict: dict | None = None,
    ) -> None:
        """Fire callback notification if configured. Never raises."""
        if not self.callback_service:
            return
        try:
            await self.callback_service.notify(job, result_dict)
        except Exception as e:
            logger.error("Callback delivery error for job %s: %s", job.id, e)
