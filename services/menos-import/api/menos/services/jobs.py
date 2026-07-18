"""Pipeline job repository for job-first authority model."""

from surrealdb import RecordID, Surreal

from menos.models import JobStatus, PipelineJob


class JobRepository:
    """Repository for pipeline_job records in SurrealDB."""

    def __init__(self, db: Surreal):
        self.db = db

    def _stringify_record_id(self, value) -> str:
        """Convert a SurrealDB RecordID to a plain string ID."""
        if hasattr(value, "record_id"):
            return str(value.record_id)
        elif hasattr(value, "id"):
            return str(value.id)
        else:
            return str(value).split(":")[-1]

    def _parse_query_result(self, result: list) -> list[dict]:
        """Parse SurrealDB query result handling v2 format variations."""
        if not result or not isinstance(result, list) or len(result) == 0:
            return []
        first = result[0]
        if isinstance(first, dict) and "result" in first:
            return first["result"] or []
        return result

    def _parse_job(self, item: dict) -> PipelineJob:
        """Parse a raw pipeline_job record into PipelineJob."""
        item_copy = dict(item)
        if "id" in item_copy:
            item_copy["id"] = self._stringify_record_id(item_copy["id"])
        # Convert content_id RecordID to plain string
        if "content_id" in item_copy and item_copy["content_id"] is not None:
            item_copy["content_id"] = self._stringify_record_id(item_copy["content_id"])
        return PipelineJob(**item_copy)

    async def create_job(self, job: PipelineJob) -> PipelineJob:
        """Create a new pipeline job.

        Args:
            job: Job to create

        Returns:
            Created job with ID
        """
        job_data = job.model_dump(exclude_none=True, mode="json")
        # Convert content_id to record reference
        job_data["content_id"] = RecordID("content", job_data["content_id"])

        result = self.db.create("pipeline_job", job_data)
        if result:
            record = result[0] if isinstance(result, list) else result
            return self._parse_job(record)
        return job

    async def get_job(self, job_id: str) -> PipelineJob | None:
        """Get a job by ID.

        Args:
            job_id: Job ID

        Returns:
            PipelineJob or None if not found
        """
        result = self.db.select(f"pipeline_job:{job_id}")
        if result:
            record = result[0] if isinstance(result, list) else result
            return self._parse_job(record)
        return None

    async def find_active_job_by_resource_key(self, resource_key: str) -> PipelineJob | None:
        """Find an active (pending/processing) job by resource key.

        Args:
            resource_key: Resource key to search for

        Returns:
            Active PipelineJob or None
        """
        result = self.db.query(
            """
            SELECT * FROM pipeline_job
            WHERE resource_key = $key AND status IN ['pending', 'processing']
            LIMIT 1
            """,
            {"key": resource_key},
        )
        raw_items = self._parse_query_result(result)
        if raw_items:
            return self._parse_job(raw_items[0])
        return None

    async def update_job_status(
        self,
        job_id: str,
        status: JobStatus,
        error_code: str | None = None,
        error_message: str | None = None,
        error_stage: str | None = None,
    ) -> PipelineJob | None:
        """Update job status with appropriate timestamps.

        Sets started_at when transitioning to processing.
        Sets finished_at when transitioning to terminal state.

        Args:
            job_id: Job ID
            status: New status
            error_code: Error code (for failed status)
            error_message: Error message (for failed status)
            error_stage: Pipeline stage where error occurred

        Returns:
            Updated PipelineJob or None
        """
        set_clauses = ["status = $status"]
        params: dict = {
            "job_id": RecordID("pipeline_job", job_id),
            "status": status.value,
        }

        # Set started_at when transitioning to processing
        if status == JobStatus.PROCESSING:
            set_clauses.append("started_at = time::now()")

        # Set finished_at for terminal states
        if status in (JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED):
            set_clauses.append("finished_at = time::now()")

        # Set error fields
        if error_code is not None:
            set_clauses.append("error_code = $error_code")
            params["error_code"] = error_code
        if error_message is not None:
            set_clauses.append("error_message = $error_message")
            params["error_message"] = error_message
        if error_stage is not None:
            set_clauses.append("error_stage = $error_stage")
            params["error_stage"] = error_stage

        query = f"""
        UPDATE pipeline_job SET
            {", ".join(set_clauses)}
        WHERE id = $job_id
        """
        result = self.db.query(query, params)
        raw_items = self._parse_query_result(result)
        if raw_items:
            return self._parse_job(raw_items[0])
        return None

    async def list_jobs(
        self,
        content_id: str | None = None,
        status: JobStatus | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> tuple[list[PipelineJob], int]:
        """List pipeline jobs with optional filtering.

        Args:
            content_id: Filter by content ID
            status: Filter by status
            limit: Maximum number to return
            offset: Number to skip

        Returns:
            Tuple of (jobs, total count)
        """
        params: dict = {"limit": limit, "offset": offset}
        where_clauses = []

        if content_id:
            where_clauses.append("content_id = $content_id")
            params["content_id"] = RecordID("content", content_id)
        if status:
            where_clauses.append("status = $status")
            params["status"] = status.value

        where_clause = ""
        if where_clauses:
            where_clause = " WHERE " + " AND ".join(where_clauses)

        result = self.db.query(
            f"""
            SELECT * FROM pipeline_job{where_clause}
            ORDER BY created_at DESC
            LIMIT $limit START $offset
            """,
            params,
        )
        raw_items = self._parse_query_result(result)
        jobs = [self._parse_job(item) for item in raw_items]
        return jobs, len(jobs)
