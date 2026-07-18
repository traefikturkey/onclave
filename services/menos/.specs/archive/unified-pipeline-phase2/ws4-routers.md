---
created: 2026-02-11
completed:
status: blocked
blocked_by: ws1, ws2, ws3
parent: plan.md
---

# Team Plan: WS4 — Router/API Cutover

## Objective

Hard cutover all ingest routers and scripts to use the unified pipeline. Remove the dual
background-task architecture (separate classification + entity extraction). Add job management
endpoints (status, reprocess, cancel). Wire callback notifications. After this workstream,
all content processing goes through the unified pipeline with job-first authority.

## Project Context

- **Language**: Python 3.12+
- **Framework**: FastAPI, Pydantic, SurrealDB
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Format command**: `cd api && uv run ruff format menos/`

## Depends On

- WS1 (unified pipeline service: `UnifiedPipelineService`, `parse_unified_response`, `llm_json.py`)
- WS2 (config + DI: `unified_pipeline_*` settings, `get_unified_pipeline_service`, `app_version`)
- WS3 (schema + job model: `PipelineJob`, `JobRepository`, `resource_key.py`, `update_content_processing_status`, `update_content_processing_result`)

## Current State (What Exists)

### WS1-WS3 Artifacts (Available to WS4)

| Artifact | Location | Key Exports |
|----------|----------|-------------|
| `UnifiedPipelineService` | `api/menos/services/unified_pipeline.py:284` | `.process(content_id, content_text, content_type, title, pre_detected, existing_topics) -> UnifiedResult \| None` |
| `parse_unified_response` | `api/menos/services/unified_pipeline.py:96` | `parse_unified_response(data, existing_tags, settings) -> UnifiedResult \| None` |
| `extract_json` | `api/menos/services/llm_json.py:11` | `extract_json(response) -> dict` |
| `UnifiedResult` | `api/menos/models.py:196` | tags, new_tags, tier, quality_score, summary, topics, etc. |
| `PipelineJob` | `api/menos/models.py:56` | id, resource_key, content_id, status, pipeline_version, data_tier, error_*, timestamps |
| `JobStatus` | `api/menos/models.py:39` | PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED |
| `DataTier` | `api/menos/models.py:49` | COMPACT, FULL |
| `JobRepository` | `api/menos/services/jobs.py:8` | create_job, get_job, find_active_job_by_resource_key, update_job_status, list_jobs |
| `generate_resource_key` | `api/menos/services/resource_key.py:72` | `generate_resource_key(content_type, identifier) -> str` (yt:ID, url:HASH, cid:ID) |
| `normalize_url` | `api/menos/services/resource_key.py:22` | URL normalization for consistent hashing |
| DI: `get_unified_pipeline_service` | `api/menos/services/di.py:381` | Wires LLM provider + repo + settings |
| DI: `get_unified_pipeline_provider` | `api/menos/services/di.py:352` | Singleton LLM provider |
| Config: `unified_pipeline_enabled` | `api/menos/config.py:72` | `bool = True` |
| Config: `unified_pipeline_max_concurrency` | `api/menos/config.py:75` | `int = 4` |
| Config: `app_version` | `api/menos/config.py:94` | Property reading from pyproject.toml |
| `update_content_processing_status` | `api/menos/services/storage.py:918` | Sets `processing_status`, `processed_at`, optional `pipeline_version` |
| `update_content_processing_result` | `api/menos/services/storage.py:952` | Sets `metadata.unified_result`, `processing_status='completed'`, `pipeline_version` |

### Routers to Cutover

**`api/menos/routers/youtube.py`** — `ingest_video()` (line 82):
- Fires TWO separate background tasks:
  1. `_classify_background()` (line 200) — calls `classification_service.classify_content()`, updates `classification_status`
  2. `_extract_entities_background()` (line 254) — calls `entity_resolution_service.process_content()`, updates `entity_extraction_status`
- Returns `YouTubeIngestResponse` with `classification_status` field
- Dependencies injected: `classification_service`, `entity_resolution_service`
- Read-only endpoints (`list_channels`, `get_video`, `list_videos`) are unaffected

**`api/menos/routers/content.py`** — `create_content()` (line 167):
- Same dual background-task pattern as youtube.py (lines 237-329)
- Dependencies injected: `classification_service`, `entity_resolution_service`
- CRUD endpoints (`list_content`, `get_content`, `update_content`, `delete_content`) are unaffected
- Link extraction/traversal endpoints are unaffected

**`api/menos/routers/classification.py`** — `classify_content()` (line 30):
- Manual trigger: `POST /api/v1/content/{content_id}/classify`
- Uses `ClassificationService` directly, updates old `classification_status` fields
- Response model uses `labels` terminology (not `tags`)
- Must be replaced with unified pipeline reprocess endpoint

### Scripts to Cutover

**`api/scripts/classify_content.py`**:
- Batch classification using `ClassificationService`
- References `classification_status`, `update_content_classification_status`, `update_content_classification`
- Line 226: sets `classification_status = "processing"` before LLM call
- Line 237: calls `update_content_classification(content_id, result.model_dump())`

**`api/scripts/reprocess_content.py`**:
- Dual-purpose: tags/links reprocessing + entity extraction
- Line 181: checks `entity_extraction_status` for skip logic
- Line 231: calls `update_content_extraction_status(content_id, "processing")`
- Entity resolution pipeline invoked directly

**`api/scripts/export_summaries.py`**:
- Line 158: queries `classification_status`, `classification_tier`, `classification_score`, `metadata.classification.labels`
- Must update to query `processing_status` and `metadata.unified_result` fields

**`api/scripts/classify_transcript.py`** — research/comparison script, NOT core pipeline. Leave unchanged.

### `api/menos/main.py` (line 13):
- Registers routers: health, auth, content, entities, graph, search, youtube, classification
- Lifespan: migrations on startup, background task cleanup on shutdown
- Background task set: `api/menos/tasks.py:5` — `background_tasks: set[asyncio.Task]`

### Locked Architecture Decisions (from plan.md)
- Decision 11: Ingest and reprocess are async job-based, return `job_id` immediately
- Decision 12: Job status endpoint with minimal + verbose tiers
- Decision 13-18: Reprocessing behavior (single-item, stored content first, return existing active job)
- Decision 19-23: Job orchestration (DB as source of truth, manual retries, bounded concurrency, best-effort cancel)
- Decision 27-31: Callback notifications (HMAC-SHA256, 3 retries, stable event_id, schema_version)

## Team Members

| Name | Agent | Role |
|------|-------|------|
| ws4-builder-1 | builder (sonnet) | Tasks 7, 8a, 8c (routers, reprocess, job status) |
| ws4-builder-2 | builder (sonnet) | Tasks 8, 8g, 8d (scripts, cancellation, callbacks) |
| ws4-validator | validator (haiku) | Run tests, lint, verify acceptance criteria |

## Complexity Analysis

| Task | Scope | Complexity | Rationale |
|------|-------|------------|-----------|
| Task 7 | Router cutover | High | Core ingest path change, response contract change, concurrency semaphore |
| Task 8 | Script rewrites | Medium | Three scripts, straightforward field name changes |
| Task 8a | Reprocess endpoint | Medium | New endpoint, stored content lookup, active job dedup |
| Task 8c | Job status endpoint | Low | Read-only, two response tiers |
| Task 8g | Cancellation endpoint | Medium | State machine logic, stage-boundary semantics |
| Task 8d | Callback notifications | High | New service, HMAC signing, retry logic, delivery state tracking |

## Execution Waves

```
Wave 1 (parallel):
  Task 7   (router cutover)        — ws4-builder-1
  Task 8   (script rewrites)       — ws4-builder-2

Wave 2 (sequential, after Wave 1):
  Task 8a  (reprocess endpoint)    — ws4-builder-1  [needs Task 7]

Wave 3 (parallel, after Wave 2):
  Task 8c  (job status endpoint)   — ws4-builder-1  [needs Task 8a]
  Task 8g  (cancel endpoint)       — ws4-builder-2  [needs Task 8a]
  Task 8d  (callback service)      — ws4-builder-2  [needs Task 8a]

Wave 4 (sequential):
  Validation                       — ws4-validator   [needs all tasks]
```

## Tasks

### Task 7: Hard cutover ingest routers

- **Owner**: ws4-builder-1
- **Blocked By**: WS1, WS2, WS3
- **Description**: Replace the dual background-task architecture in `youtube.py` and `content.py` with single unified pipeline jobs. Remove the `classification.py` router entirely.

  **Step 7.1: Create job orchestration helper**

  Create `api/menos/services/pipeline_orchestrator.py` with:
  ```python
  class PipelineOrchestrator:
      """Coordinates unified pipeline execution with job lifecycle."""

      def __init__(
          self,
          pipeline_service: UnifiedPipelineService,
          job_repo: JobRepository,
          surreal_repo: SurrealDBRepository,
          settings: Settings,
      ): ...

      async def submit_job(
          self,
          content_id: str,
          content_text: str,
          content_type: str,
          title: str,
          resource_key: str,
          pre_detected: list | None = None,
          existing_topics: list[str] | None = None,
      ) -> PipelineJob:
          """Create job, check idempotency, launch background processing."""
          ...
  ```

  The orchestrator:
  1. Checks for active job via `job_repo.find_active_job_by_resource_key(resource_key)` — returns existing if found (Decision 17)
  2. Creates `PipelineJob(resource_key=resource_key, content_id=content_id, pipeline_version=settings.app_version)`
  3. Sets `content.processing_status = "pending"` via `surreal_repo.update_content_processing_status()`
  4. Launches background task (bounded by `asyncio.Semaphore(settings.unified_pipeline_max_concurrency)`)
  5. Background task: transitions job to `processing`, calls `pipeline_service.process()`, stores result via `surreal_repo.update_content_processing_result()`, transitions job to `completed` or `failed`

  **Step 7.2: Add DI wiring**

  Add to `api/menos/services/di.py`:
  ```python
  async def get_job_repository() -> JobRepository:
      repo = await get_surreal_repo()
      return JobRepository(repo.db)

  async def get_pipeline_orchestrator() -> PipelineOrchestrator:
      ...
  ```

  **Step 7.3: Cutover `youtube.py`**

  In `api/menos/routers/youtube.py`:
  - Remove imports: `ClassificationService`, `EntityResolutionService`, `get_classification_service`, `get_entity_resolution_service`, `background_tasks`
  - Add imports: `PipelineOrchestrator`, `get_pipeline_orchestrator`, `generate_resource_key`
  - Remove dependency injection of `classification_service` and `entity_resolution_service` from `ingest_video()`
  - Add dependency injection of `orchestrator: PipelineOrchestrator`
  - Delete entire `_classify_background()` closure (lines 200-247)
  - Delete entire `_extract_entities_background()` closure (lines 254-289)
  - Delete `classification_status` logic and min-length gate (lines 193-248)
  - Replace with:
    ```python
    resource_key = generate_resource_key("youtube", video_id)
    job = await orchestrator.submit_job(
        content_id=content_id,
        content_text=transcript.full_text,
        content_type="youtube",
        title=video_title,
        resource_key=resource_key,
    )
    ```
  - Update `YouTubeIngestResponse`: replace `classification_status: str | None = None` with `job_id: str | None = None`
  - Return `job_id=job.id` in response

  **Step 7.4: Cutover `content.py`**

  In `api/menos/routers/content.py`:
  - Same import swap as youtube.py
  - Remove `classification_service` and `entity_resolution_service` dependency injection from `create_content()`
  - Add `orchestrator: PipelineOrchestrator` dependency injection
  - Delete entire `_classify_background()` closure (lines 237-289)
  - Delete entire `_extract_entities_background()` closure (lines 295-329)
  - Replace with orchestrator call using `generate_resource_key(content_type, final_content_id)`
  - Update `ContentCreateResponse`: add `job_id: str | None = None`
  - Return `job_id=job.id`

  **Step 7.5: Remove classification router**

  - Delete `api/menos/routers/classification.py` (entire file — replaced by Task 8a reprocess endpoint)
  - Remove from `api/menos/main.py` line 13: remove `classification` from router imports
  - Remove from `api/menos/main.py` line 91: remove `app.include_router(classification.router, ...)`
  - Add jobs router (created in Task 8c): `app.include_router(jobs.router, prefix="/api/v1")`

  **Step 7.6: Write tests**

  Create `api/tests/unit/test_pipeline_orchestrator.py`:
  - Test submit_job happy path: creates job, sets processing_status, launches background task
  - Test idempotency: active job exists -> returns existing job, no new job created
  - Test concurrency: semaphore limits parallel pipeline calls
  - Test pipeline failure: job transitions to FAILED with error fields
  - Test pipeline success: job transitions to COMPLETED, result stored via `update_content_processing_result`

  Update `api/tests/unit/test_youtube_router.py` (or create if missing):
  - Test ingest_video returns `job_id` instead of `classification_status`
  - Test background processing uses orchestrator

  Update `api/tests/unit/test_content_router.py` (or create if missing):
  - Test create_content returns `job_id`

- **Acceptance Criteria**:
  - [ ] No `ClassificationService` or `EntityResolutionService` imports in youtube.py or content.py
  - [ ] No `_classify_background` or `_extract_entities_background` closures remain
  - [ ] No `classification_status`, `update_content_classification_status`, or `update_content_extraction_status` calls in routers
  - [ ] Both ingest endpoints return `job_id`
  - [ ] `classification.py` router deleted
  - [ ] `main.py` no longer registers classification router
  - [ ] `PipelineOrchestrator` handles job lifecycle with bounded concurrency
  - [ ] Active job dedup works (Decision 17)
  - [ ] All new and existing tests pass
  - [ ] `uv run ruff check menos/` passes

### Task 8: Rewrite scripts to unified status model

- **Owner**: ws4-builder-2
- **Blocked By**: WS3 (needs `processing_status` fields in schema)
- **Description**: Update three scripts to use `processing_status` and unified result fields.

  **Step 8.1: Rewrite `classify_content.py`**

  In `api/scripts/classify_content.py`:
  - Replace `ClassificationService` usage with `UnifiedPipelineService`
  - Replace `update_content_classification_status(content_id, "processing")` with `update_content_processing_status(content_id, "processing", pipeline_version=settings.app_version)`
  - Replace `update_content_classification(content_id, result.model_dump())` with `update_content_processing_result(content_id, result.model_dump(), pipeline_version=settings.app_version)`
  - Replace `update_content_classification_status(content_id, "failed")` with `update_content_processing_status(content_id, "failed")`
  - Replace check `item.metadata.get("classification")` with check for `processing_status == "completed"` (query raw record)
  - Create pipeline service using `get_unified_pipeline_provider()` + repo + settings
  - Remove `_create_classification_service()` helper
  - Remove `VaultInterestProvider` usage

  **Step 8.2: Rewrite `reprocess_content.py`**

  In `api/scripts/reprocess_content.py`:
  - Replace `entity_extraction_status` check (line 181) with `processing_status` check
  - Replace `update_content_extraction_status` calls (lines 231, 261) with `update_content_processing_status`
  - The existing tags/links reprocessing logic is unrelated to the pipeline and should remain as-is
  - The `--entities-only` mode should now use unified pipeline instead of entity_resolution directly
  - Consider renaming `--entities-only` to `--pipeline-only` or keeping for backward compatibility

  **Step 8.3: Rewrite `export_summaries.py`**

  In `api/scripts/export_summaries.py`:
  - Replace raw query (lines 157-169) that reads `classification_status`, `classification_tier`, `classification_score`, `metadata.classification.labels`
  - New query should read: `processing_status`, `metadata.unified_result.tier`, `metadata.unified_result.quality_score`, `metadata.unified_result.tags`
  - Update `create_frontmatter()`: rename `classification_tier` -> `tier`, `classification_score` -> `quality_score`, `classification_labels` -> `tags`
  - Use `processing_status == "completed"` instead of `classification_status == "completed"`

  **Step 8.4: Write tests**

  Add/update test coverage for script behavior changes. At minimum, verify:
  - `classify_content.py` creates `UnifiedPipelineService` (not `ClassificationService`)
  - `export_summaries.py` queries `processing_status` and `metadata.unified_result`

- **Acceptance Criteria**:
  - [ ] No references to `classification_status`, `classification_tier`, `classification_score`, `entity_extraction_status` in any script
  - [ ] No references to `ClassificationService` in `classify_content.py`
  - [ ] No references to `update_content_classification*` in any script
  - [ ] `export_summaries.py` reads from `metadata.unified_result` fields
  - [ ] All scripts use `processing_status` for status checks
  - [ ] `uv run ruff check scripts/` passes (or equivalent lint scope)

### Task 8a: Reprocess API endpoint

- **Owner**: ws4-builder-1
- **Blocked By**: Task 7
- **Description**: Create a single-item reprocess endpoint that replaces the old `classify_content` manual trigger.

  Create in `api/menos/routers/jobs.py`:
  ```python
  @router.post("/content/{content_id}/reprocess")
  async def reprocess_content(
      content_id: str,
      key_id: AuthenticatedKeyId,
      force: bool = Query(default=False),
      orchestrator: PipelineOrchestrator = Depends(get_pipeline_orchestrator),
      surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
      minio_storage: MinIOStorage = Depends(get_minio_storage),
  ) -> ReprocessResponse:
  ```

  Behavior (per Decisions 13-18):
  1. Verify content exists (404 if not)
  2. Check for active job: `job_repo.find_active_job_by_resource_key(resource_key)` — return existing `job_id` if found (Decision 17)
  3. If not force and `processing_status == "completed"`, return existing result info
  4. Download content text from MinIO (uses stored content first, Decision 15)
  5. For YouTube: get metadata from MinIO `youtube/{video_id}/metadata.json` for title/metadata (Decision 16: only fetch externally if required fields missing)
  6. Submit unified pipeline job via orchestrator
  7. Return `ReprocessResponse(job_id=job.id, status="submitted")`

  Response model:
  ```python
  class ReprocessResponse(BaseModel):
      job_id: str
      content_id: str
      status: str  # "submitted", "already_active", "already_completed"
  ```

- **Acceptance Criteria**:
  - [ ] `POST /api/v1/content/{content_id}/reprocess` endpoint works
  - [ ] Returns existing active `job_id` if one exists (no duplicate jobs)
  - [ ] Uses stored content from MinIO (no external re-fetch for existing content)
  - [ ] `?force=true` bypasses "already completed" check
  - [ ] 404 for nonexistent content_id
  - [ ] Tests cover: happy path, active job dedup, force reprocess, content not found

### Task 8c: Job status endpoint

- **Owner**: ws4-builder-1
- **Blocked By**: Task 8a
- **Description**: Create job status endpoint with two response tiers (Decision 12).

  Add to `api/menos/routers/jobs.py`:
  ```python
  @router.get("/jobs/{job_id}")
  async def get_job_status(
      job_id: str,
      key_id: AuthenticatedKeyId,
      verbose: bool = Query(default=False),
      job_repo: JobRepository = Depends(get_job_repository),
  ) -> JobStatusResponse:
  ```

  Response models:
  ```python
  class JobStatusMinimal(BaseModel):
      job_id: str
      status: str
      content_id: str
      created_at: str | None
      finished_at: str | None

  class JobStatusVerbose(JobStatusMinimal):
      resource_key: str
      pipeline_version: str
      data_tier: str
      started_at: str | None
      error_code: str | None
      error_message: str | None
      error_stage: str | None
      metadata: dict | None
  ```

  Also add a job listing endpoint:
  ```python
  @router.get("/jobs")
  async def list_jobs(
      key_id: AuthenticatedKeyId,
      content_id: str | None = Query(default=None),
      status: str | None = Query(default=None),
      limit: int = Query(default=50, ge=1, le=100),
      offset: int = Query(default=0, ge=0),
      job_repo: JobRepository = Depends(get_job_repository),
  ) -> JobListResponse:
  ```

- **Acceptance Criteria**:
  - [ ] `GET /api/v1/jobs/{job_id}` returns minimal response by default
  - [ ] `?verbose=true` returns full diagnostics tier
  - [ ] 404 for nonexistent job_id
  - [ ] `GET /api/v1/jobs` lists jobs with optional filters
  - [ ] Tests cover both tiers and filtering

### Task 8g: Job cancellation endpoint

- **Owner**: ws4-builder-2
- **Blocked By**: Task 8a
- **Description**: Implement best-effort job cancellation (Decisions 22-23).

  Add to `api/menos/routers/jobs.py`:
  ```python
  @router.post("/jobs/{job_id}/cancel")
  async def cancel_job(
      job_id: str,
      key_id: AuthenticatedKeyId,
      job_repo: JobRepository = Depends(get_job_repository),
      surreal_repo: SurrealDBRepository = Depends(get_surreal_repo),
  ) -> CancelResponse:
  ```

  Cancellation logic:
  - `pending` -> immediate cancel: `update_job_status(job_id, CANCELLED)`, update `content.processing_status = "cancelled"`
  - `processing` -> mark for cancellation: set a flag that the orchestrator's background task checks between pipeline stages (best-effort, Decision 22)
  - Already terminal (`completed`, `failed`, `cancelled`) -> return current state, no-op

  Add cancellation check to `PipelineOrchestrator`:
  - Between job creation and pipeline execution, check if job was cancelled
  - The orchestrator checks the cancel flag before calling `pipeline_service.process()`

  Response model:
  ```python
  class CancelResponse(BaseModel):
      job_id: str
      status: str  # new status after cancel attempt
      cancelled: bool  # whether cancellation was applied
  ```

- **Acceptance Criteria**:
  - [ ] `POST /api/v1/jobs/{job_id}/cancel` works
  - [ ] Pending jobs are immediately cancelled
  - [ ] Processing jobs are cancelled at stage boundary (best-effort)
  - [ ] Terminal jobs return current state (no error)
  - [ ] 404 for nonexistent job_id
  - [ ] Content `processing_status` updated to "cancelled" when job is cancelled
  - [ ] Tests cover: cancel pending, cancel processing, cancel terminal, not found

### Task 8d: Callback notifications

- **Owner**: ws4-builder-2
- **Blocked By**: Task 8a
- **Description**: Implement optional callback notifications with HMAC-SHA256 signatures (Decisions 27-31).

  **Step 8d.1: Create callback service**

  Create `api/menos/services/callbacks.py`:
  ```python
  class CallbackService:
      """Sends signed webhook notifications for pipeline events."""

      def __init__(self, settings: Settings): ...

      async def notify(
          self,
          callback_url: str,
          callback_secret: str,
          job: PipelineJob,
          result: UnifiedResult | None,
      ) -> None:
          """Send callback with HMAC-SHA256 signature and retry logic."""
          ...
  ```

  Callback payload:
  ```json
  {
      "schema_version": "1",
      "callback_event_id": "<stable UUID>",
      "job_id": "...",
      "content_id": "...",
      "status": "completed",
      "pipeline_version": "...",
      "result_summary": { "tier": "B", "quality_score": 55, "tag_count": 5 }
  }
  ```

  Implementation:
  - Generate stable `callback_event_id` from `job_id` (deterministic, for idempotent receivers, Decision 29)
  - Sign payload with `HMAC-SHA256(callback_secret, json_body)`, include in `X-Signature-256` header
  - Include `schema_version: "1"` in payload (Decision 30)
  - Retry policy: 3 attempts with exponential backoff (1s, 4s, 16s) (Decision 28)
  - Callback delivery state is independent from pipeline outcome (Decision 31) — log failures but don't fail the job
  - Use `httpx.AsyncClient` for HTTP calls

  **Step 8d.2: Add callback configuration**

  Add to `api/menos/config.py`:
  ```python
  callback_enabled: bool = False
  callback_url: str = ""
  callback_secret: str = ""
  ```

  **Step 8d.3: Wire into orchestrator**

  After pipeline completion (success or failure), if `callback_enabled` and `callback_url` are set, fire callback as background task. Callback failure must not affect job outcome.

  **Step 8d.4: Add DI wiring**

  Add to `di.py`:
  ```python
  def get_callback_service() -> CallbackService:
      return CallbackService(settings=settings)
  ```

  **Step 8d.5: Write tests**

  Create `api/tests/unit/test_callbacks.py`:
  - Test HMAC signature generation and verification
  - Test stable callback_event_id from job_id
  - Test retry behavior (mock httpx to fail then succeed)
  - Test callback failure doesn't affect job status
  - Test schema_version is included in payload

- **Acceptance Criteria**:
  - [ ] `CallbackService` exists with HMAC-SHA256 signing
  - [ ] Callback fires after pipeline completion (success or failure)
  - [ ] Retry: 3 attempts with exponential backoff
  - [ ] Stable `callback_event_id` per job (idempotent receivers)
  - [ ] `schema_version` in payload
  - [ ] Callback failure does not affect pipeline job outcome
  - [ ] Config: `callback_enabled`, `callback_url`, `callback_secret`
  - [ ] All tests pass

### Task V4: WS4 Validation

- **Owner**: ws4-validator
- **Blocked By**: Tasks 7, 8, 8a, 8c, 8g, 8d
- **Description**: Run linters, all unit tests, and verify all acceptance criteria.

  **Verification Commands**:
  ```bash
  cd api && uv run ruff check menos/
  cd api && uv run ruff format --check menos/
  cd api && uv run pytest tests/unit/ -v
  ```

  **Verification Checklist**:
  - All linters pass with zero warnings
  - All unit tests pass (new and existing)
  - No debug statements (`print()`, `breakpoint()`, `pdb`)
  - No hardcoded secrets or API keys
  - No references to `classification_status`, `entity_extraction_status`, `update_content_classification*`, or `update_content_extraction_status` in routers or scripts
  - `classification.py` router file deleted
  - `main.py` registers `jobs.router`, does NOT register `classification.router`
  - Both ingest endpoints return `job_id`
  - All new endpoints work: reprocess, job status, job cancel
  - Callback service has HMAC signing with tests
  - Scripts use `processing_status` and `metadata.unified_result`

## Dependency Graph

```
WS1 + WS2 + WS3 ──────────> Task 7 (router cutover)
                              │
WS3 ────────────────────────> Task 8 (script rewrites)
                              │
Task 7 ───────────────┬──────> Task 8a (reprocess endpoint)
                      │        │
                      │        ├──> Task 8c (job status)
                      │        │
                      │        └──> Task 8d (callbacks)
                      │
                      └──> Task 8g (cancel endpoint)
                              │
Tasks 7, 8, 8a, 8c, 8d, 8g ──> Task V4 (validation)
```

## Files to Create

| File | Task | Purpose |
|------|------|---------|
| `api/menos/services/pipeline_orchestrator.py` | 7 | Job lifecycle, background processing, concurrency |
| `api/menos/services/callbacks.py` | 8d | HMAC-signed webhook notifications |
| `api/menos/routers/jobs.py` | 8a, 8c, 8g | Reprocess, job status, job cancel endpoints |
| `api/tests/unit/test_pipeline_orchestrator.py` | 7 | Orchestrator tests |
| `api/tests/unit/test_callbacks.py` | 8d | Callback service tests |
| `api/tests/unit/test_jobs_router.py` | 8a, 8c, 8g | Jobs router endpoint tests |

## Files to Modify

| File | Task | Changes |
|------|------|---------|
| `api/menos/routers/youtube.py` | 7 | Remove dual tasks, add orchestrator, return job_id |
| `api/menos/routers/content.py` | 7 | Remove dual tasks, add orchestrator, return job_id |
| `api/menos/main.py` | 7 | Remove classification router, add jobs router |
| `api/menos/services/di.py` | 7, 8d | Add `get_job_repository`, `get_pipeline_orchestrator`, `get_callback_service` |
| `api/menos/config.py` | 8d | Add callback settings |
| `api/scripts/classify_content.py` | 8 | Use unified pipeline, processing_status |
| `api/scripts/reprocess_content.py` | 8 | Use processing_status |
| `api/scripts/export_summaries.py` | 8 | Query unified_result fields |

## Files to Delete

| File | Task | Reason |
|------|------|--------|
| `api/menos/routers/classification.py` | 7 | Replaced by reprocess endpoint in jobs router |

## Files NOT to Touch

- `api/menos/services/unified_pipeline.py` — WS1 artifact, no changes needed
- `api/menos/services/jobs.py` — WS3 artifact, no changes needed
- `api/menos/services/resource_key.py` — WS3 artifact, no changes needed
- `api/menos/services/storage.py` — WS3 artifact, no changes needed
- `api/menos/routers/graph.py` — WS5 scope (Task 9)
- `api/menos/routers/health.py` — Already returns `app_version`, no changes needed
- `api/menos/services/classification.py` — Legacy service, removal is WS5 (Task 11)
- `api/menos/services/entity_extraction.py` — Legacy service, removal is WS5 (Task 11)
- `api/menos/services/entity_resolution.py` — Legacy service, removal is WS5 (Task 11)
- `api/scripts/classify_transcript.py` — Research script, not core pipeline

## Final Step: Commit

After validation passes, create a commit with all WS4 changes:
- Determine semver bump level (`major` — breaking change to ingest API contract, returns job_id instead of classification_status)
- Run `make version-bump-major` from repo root
- Stage all changed files (excluding unrelated/untracked files)
- Commit message format: `feat!: hard cutover ingest to unified pipeline with job-based API`
- Include bump level and rationale in commit body
