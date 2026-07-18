---
paths:
  - "api/**/*.py"
  - "api/scripts/**"
---

# Database Schema

## SurrealDB Tables

### content (ContentMetadata)

| Field | Type | Notes |
|-------|------|-------|
| id | str\|None | SurrealDB RecordID, e.g. `content:abc123` |
| content_type | str | `"youtube"`, `"pdf"`, `"text"` |
| title | str\|None | |
| description | str\|None | |
| mime_type | str | e.g. `"text/plain"` |
| file_size | int | bytes |
| file_path | str | MinIO path |
| author | str\|None | |
| tags | list[str] | default `[]` |
| tier | str\|None | Quality tier: `S`, `A`, `B`, `C`, `D` |
| created_at | datetime\|None | UTC |
| updated_at | datetime\|None | UTC |
| metadata | dict | varies by content_type |
| processing_status | str\|None | `pending`, `processing`, `completed`, `failed` |
| processed_at | datetime\|None | UTC timestamp of last processing |
| pipeline_version | str\|None | App version that processed this content |

### pipeline_job (PipelineJob)

| Field | Type | Notes |
|-------|------|-------|
| id | str\|None | SurrealDB RecordID |
| resource_key | str | Canonical key for deduplication (e.g. `yt:dQw4w9WgXcQ`) |
| content_id | str | FK to content table |
| status | str | `pending`, `processing`, `completed`, `failed`, `cancelled` |
| pipeline_version | str | App version at job creation |
| data_tier | str | `compact` or `full` |
| idempotency_key | str\|None | Optional client-provided key |
| error_code | str\|None | Error code if failed |
| error_message | str\|None | Error message if failed |
| error_stage | str\|None | Pipeline stage where error occurred |
| metadata | dict | Additional job metadata |
| created_at | datetime\|None | UTC |
| started_at | datetime\|None | When processing began |
| finished_at | datetime\|None | When processing completed/failed |

### chunk (ChunkModel)

| Field | Type | Notes |
|-------|------|-------|
| id | str\|None | SurrealDB RecordID |
| content_id | str | FK to content table |
| text | str | 512 chars + 50 char overlap |
| chunk_index | int | 0-based position |
| embedding | list[float]\|None | 1024-dim vector embedding |
| created_at | datetime\|None | UTC |

## SurrealDB v2 Result Handling
- Direct list format vs wrapped `{"result": [...]}` — handle both
- RecordID objects: check `hasattr(value, "id")` and use `value.id`

## Resource Key Patterns
Resource keys provide canonical deduplication for content across ingestion methods:
- `yt:<video_id>` — YouTube video (e.g. `yt:dQw4w9WgXcQ`)
- `url:<hash16>` — URL-based content (e.g. `url:a3b4c5d6e7f8g9h0`)
- `cid:<content_id>` — Content ID fallback (e.g. `cid:content:01HZYX...`)

## Key Patterns
- Storage access: `async with get_storage_context() as (minio, surreal)` from `menos.services.di`
- Scripts run from `api/` dir with `PYTHONPATH=. uv run python scripts/<name>.py`
- Query tool: `api/scripts/query.py` — read-only SurrealQL queries
- Job-first authority: Pipeline jobs are source of truth; content status mirrors job status
- Resource key dedup: One active job per resource key at a time
