# Unified Pipeline Specification

## 1. Overview

The unified pipeline replaces the legacy two-stage classification and entity extraction system with a single LLM call that produces tags, quality ratings, summaries, topics, and entity validations in one pass. This reduces latency, token costs, and improves coherence between classification and extraction outputs.

**Key Benefits:**
- Single LLM round trip (classification + entity extraction)
- Prompt includes existing tags and topics for consistency
- Pre-detected entity validation (URL pattern matching) confirmed by LLM
- Deterministic tag deduplication with Levenshtein distance

**Implementation:** `api/menos/services/unified_pipeline.py`

## 2. Pipeline Flow

### Entry Point
**Function:** `pipeline_orchestrator.py:submit(content_id, content_text, content_type, title, resource_key)`

1. Check for existing active job by `resource_key` (idempotency)
2. Create `PipelineJob` with status `PENDING`
3. Update content `processing_status = "pending"`
4. Launch background task `_run_pipeline()` with concurrency semaphore

### Execution
**Function:** `unified_pipeline.py:process(content_id, content_text, content_type, title, pre_detected, existing_topics, job_id)`

1. **Truncation Stage:** Truncate content to 10k characters
2. **Tag Fetch Stage:** Retrieve existing tags via `SurrealDBRepository.list_tags_with_counts()`
3. **LLM Call Stage:** Generate unified response with existing tags and topics in prompt
4. **Parse Stage:** Validate and parse JSON response into `UnifiedResult`

**Error Handling:** Raises `PipelineStageError(stage, code, message)` with structured observability metadata.

### Persistence
**Function:** `storage.py:update_content_processing_result(content_id, result_dict, pipeline_version)`

1. Store result in `content.metadata.unified_result`
2. Set `processing_status = "completed"`
3. Update `processed_at = time::now()`
4. Record `pipeline_version` for auditing

### Callbacks (Optional)
**Function:** `callbacks.py:notify(job, result_dict)`

- Delivers HMAC-SHA256 signed webhook on job completion
- Retry policy: 1s, 4s, 16s exponential backoff
- Fire-and-forget (delivery failures logged, never propagated)

## 3. Input/Output Contract

### UnifiedResult Model

```python
class UnifiedResult(BaseModel):
    tags: list[str]                      # Final merged tags
    new_tags: list[str]                  # Newly created tags
    tier: str                            # S, A, B, C, D
    tier_explanation: list[str]          # 2-3 bullet points
    quality_score: int                   # 1-100
    score_explanation: list[str]         # 2-3 bullet points
    summary: str                         # 2-3 sentence overview + 3-5 bullets
    topics: list[ExtractedEntity]        # Hierarchical topics
    pre_detected_validations: list[PreDetectedValidation]  # Validated URL entities
    additional_entities: list[ExtractedEntity]  # Newly discovered entities
    model: str                           # LLM model name
    processed_at: str                    # ISO 8601 timestamp
```

**Validation Rules:**
- `tags`: Match `^[a-z][a-z0-9-]*$` pattern
- `new_tags`: Limited to `UNIFIED_PIPELINE_MAX_NEW_TAGS` (default: 3)
- `tier`: Must be in `{S, A, B, C, D}`, defaults to `C`
- `quality_score`: Clamped to `1-100`, defaults to `50`
- `topics`: Limited to `ENTITY_MAX_TOPICS_PER_CONTENT` (default: 7)
- `confidence`: Filtered by `ENTITY_MIN_CONFIDENCE` (default: 0.6)

### Tag Deduplication

**Function:** `_dedup_label(new_label, existing_labels, max_distance=2)`

Uses `normalization.normalize_name()` + Levenshtein distance to merge near-duplicates:
- Normalize: lowercase, strip accents, remove non-alphanumeric
- If `distance(normalized_new, normalized_existing) <= 2`: return existing tag
- Prevents LLM tag drift ("home-lab" vs "homelab" vs "home_lab")

## 4. Job Lifecycle

### PipelineJob States

```
PENDING → PROCESSING → COMPLETED
                    ↘ FAILED
                    ↘ CANCELLED
```

**State Transitions:**
- `PENDING → PROCESSING`: Job acquires semaphore slot, sets `started_at`
- `PROCESSING → COMPLETED`: Result stored, sets `finished_at`
- `PROCESSING → FAILED`: Error caught, sets `error_code`, `error_message`, `error_stage`, `finished_at`
- `PENDING → CANCELLED`: User cancellation before processing starts
- `PROCESSING → CANCELLED`: Graceful shutdown via `asyncio.CancelledError`

### Job-First Authority Model

**Authority:** `pipeline_job` table is source of truth for pipeline execution status.

**Content Status Sync:**
- `content.processing_status` mirrors job status for query convenience
- `content.pipeline_version` tracks which pipeline version processed the content
- `content.processed_at` records completion timestamp

**Deduplication:** Active job lookup by `resource_key` prevents duplicate processing.

## 5. Resource Keys

**Module:** `services/resource_key.py`

Resource keys provide canonical identifiers for deduplication across ingestion retries and reprocessing.

**Formats:**

| Content Type | Format | Example |
|--------------|--------|---------|
| YouTube | `yt:<video_id>` | `yt:dQw4w9WgXcQ` |
| URL | `url:<hash16>` | `url:Zx8vQ2Lp9KjN3M` |
| Other | `cid:<content_id>` | `cid:abc123xyz` |

**URL Hash Generation:**
1. Normalize URL: lowercase scheme/host, upgrade http→https, strip tracking params
2. SHA-256 hash of normalized URL
3. Base64-urlsafe encode first 12 bytes, strip padding (`=`)

## 6. API Endpoints

**Router:** `routers/jobs.py`

### POST /api/v1/content/{content_id}/reprocess

Submit existing content for unified pipeline reprocessing.

**Query Parameters:**
- `force=false`: Skip if `processing_status == "completed"` (default)
- `force=true`: Reprocess regardless of status

**Response:**
```json
{
  "job_id": "abc123",
  "content_id": "xyz789",
  "status": "submitted" | "already_active" | "already_completed"
}
```

### GET /api/v1/jobs/{job_id}

Get pipeline job status.

**Query Parameters:**
- `verbose=false`: Return compact status (default)
- `verbose=true`: Include error details, metadata, timestamps (logs `audit.full_tier_access`)

**Response (verbose=false):**
```json
{
  "job_id": "abc123",
  "content_id": "xyz789",
  "status": "pending",
  "created_at": "2026-02-11T10:00:00Z",
  "started_at": null,
  "finished_at": null
}
```

**Response (verbose=true):**
```json
{
  "job_id": "abc123",
  "content_id": "xyz789",
  "status": "failed",
  "created_at": "2026-02-11T10:00:00Z",
  "started_at": "2026-02-11T10:00:05Z",
  "finished_at": "2026-02-11T10:00:12Z",
  "error_code": "LLM_CALL_ERROR",
  "error_message": "Connection timeout after 120s",
  "error_stage": "llm_call",
  "resource_key": "yt:dQw4w9WgXcQ",
  "pipeline_version": "0.2.0",
  "metadata": {}
}
```

### GET /api/v1/jobs

List pipeline jobs with filtering.

**Query Parameters:**
- `content_id`: Filter by content ID
- `status`: Filter by status (`pending`, `processing`, `completed`, `failed`, `cancelled`)
- `limit=50`: Max results (1-100)
- `offset=0`: Pagination offset

**Response:**
```json
{
  "jobs": [
    {
      "job_id": "abc123",
      "content_id": "xyz789",
      "status": "completed",
      "created_at": "2026-02-11T10:00:00Z",
      "started_at": "2026-02-11T10:00:05Z",
      "finished_at": "2026-02-11T10:00:30Z"
    }
  ],
  "total": 1
}
```

### POST /api/v1/jobs/{job_id}/cancel

Cancel a pipeline job.

**Behavior:**
- `pending`: Immediately cancelled
- `processing`: Best-effort (checked before pipeline execution)
- Terminal states (`completed`, `failed`, `cancelled`): No-op, returns current status

**Response:**
```json
{
  "job_id": "abc123",
  "status": "cancelled",
  "message": "Job cancelled"
}
```

## 7. Configuration

**Module:** `config.py`

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `UNIFIED_PIPELINE_ENABLED` | bool | `true` | Master toggle for pipeline |
| `UNIFIED_PIPELINE_PROVIDER` | str | `"openrouter"` | LLM provider: `ollama`, `openai`, `anthropic`, `openrouter`, `none` |
| `UNIFIED_PIPELINE_MODEL` | str | `""` | Model name (provider-specific) |
| `UNIFIED_PIPELINE_MAX_CONCURRENCY` | int | `4` | Semaphore limit for concurrent pipeline jobs |
| `UNIFIED_PIPELINE_MAX_NEW_TAGS` | int | `3` | Max new tags allowed per LLM response |
| `ENTITY_MAX_TOPICS_PER_CONTENT` | int | `7` | Max topic entities to extract |
| `ENTITY_MIN_CONFIDENCE` | float | `0.6` | Minimum confidence threshold for entities |
| `CALLBACK_URL` | str | `None` | Webhook URL for job completion notifications |
| `CALLBACK_SECRET` | str | `None` | HMAC-SHA256 secret for webhook signatures |

## 8. Callbacks

**Module:** `services/callbacks.py`

### Webhook Payload

```json
{
  "schema_version": "1",
  "event_id": "uuid5-deterministic-from-job-id",
  "job_id": "abc123",
  "content_id": "xyz789",
  "resource_key": "yt:dQw4w9WgXcQ",
  "status": "completed",
  "pipeline_version": "0.2.0",
  "result": {
    "tags": ["kubernetes", "home-lab"],
    "tier": "B",
    "quality_score": 72
  }
}
```

### Signature Verification

**Header:** `X-Menos-Signature: <hex-hmac-sha256>`

**Verification:**
```python
import hmac
import hashlib

expected = hmac.new(
    callback_secret.encode(),
    request_body.encode(),
    hashlib.sha256
).hexdigest()

assert request.headers["X-Menos-Signature"] == expected
```

**Canonical JSON:** `json.dumps(payload, separators=(',', ':'), sort_keys=True)`

### Retry Policy

- **Attempts:** 3
- **Delays:** 1s, 4s, 16s (exponential backoff)
- **Timeout:** 10s per attempt
- **Failure Handling:** Logged as `audit.callback_delivery success=false`, never propagated

## 9. Observability

### Correlation IDs

All pipeline logs include `job_id=<id>` for distributed tracing.

**Example:**
```
stage.truncation job_id=abc123 content_id=xyz789 ms=2
stage.tag_fetch job_id=abc123 content_id=xyz789 ms=45 tags=127
stage.llm_call job_id=abc123 content_id=xyz789 ms=3200 token_est=4500
stage.parse job_id=abc123 content_id=xyz789 ms=8
pipeline.complete job_id=abc123 content_id=xyz789 tier=B score=72 tags=['k8s'] topics=4
```

### Stage Metrics

| Stage | Metric | Description |
|-------|--------|-------------|
| `truncation` | `ms` | Truncation time (typically <5ms) |
| `tag_fetch` | `ms`, `tags` | DB query time, tag count |
| `llm_call` | `ms`, `token_est` | LLM response time, estimated tokens |
| `parse` | `ms` | JSON parsing and validation time |

### Audit Events

| Event | Fields | Description |
|-------|--------|-------------|
| `audit.reprocess_trigger` | `content_id`, `force`, `key_id` | Manual reprocess request |
| `audit.full_tier_access` | `job_id`, `key_id` | Verbose job details accessed (PII/error messages) |
| `audit.cancellation` | `job_id`, `outcome`, `key_id` | Job cancellation attempt |
| `audit.callback_delivery` | `job_id`, `attempt`, `success` | Webhook delivery result |

### Error Taxonomy

**PipelineStageError:**
- `TAG_FETCH_ERROR`: Database query failure during tag retrieval
- `LLM_CALL_ERROR`: LLM provider timeout or API error
- `EMPTY_RESPONSE`: LLM returned empty or non-JSON response
- `PARSE_FAILED`: JSON structure invalid or missing required fields
- `PIPELINE_NO_RESULT`: Pipeline returned `None` (disabled or skipped)
- `PIPELINE_EXCEPTION`: Unhandled exception in pipeline execution

**Storage in Job:**
- `error_code`: Enum-like string (e.g., `LLM_CALL_ERROR`)
- `error_message`: First 500 chars of exception message
- `error_stage`: Pipeline stage where error occurred (`tag_fetch`, `llm_call`, `parse`, `unknown`)

## 10. Data Tiers

**Module:** `services/jobs.py:purge_expired_jobs()`

Pipeline jobs use tiered retention based on `data_tier` field.

| Tier | Retention | Use Case |
|------|-----------|----------|
| `compact` | 6 months | Default for most content |
| `full` | 2 months | High-detail debugging, verbose logs |

**Purge Policy:**
- Runs on app startup via `main.py` lifespan handler
- Deletes jobs where `finished_at < time::now() - <retention>`
- Logs: `Purged N expired pipeline jobs (compact=X, full=Y)`

**Purge Query (compact):**
```sql
DELETE FROM pipeline_job
WHERE data_tier = 'compact'
  AND finished_at != NONE
  AND finished_at < time::now() - 180d
RETURN BEFORE
```

**Purge Query (full):**
```sql
DELETE FROM pipeline_job
WHERE data_tier = 'full'
  AND finished_at != NONE
  AND finished_at < time::now() - 60d
RETURN BEFORE
```

**Note:** `content.metadata.unified_result` persists indefinitely regardless of job retention tier.
