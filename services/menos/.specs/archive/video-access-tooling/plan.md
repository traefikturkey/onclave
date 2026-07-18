---
created: 2026-02-11
completed: 2026-02-11
---

# Team Plan: Video Access Tooling

## Objective
Add API endpoints and local CLI tooling to retrieve video transcripts, metadata, and pipeline results so they can be accessed during local Claude Code discussions about a video's contents.

Currently, the full transcript is only in MinIO (no API download), the `GET /youtube/{video_id}` endpoint returns only a 500-char preview with no pipeline results, and there is no local script to fetch everything for a video in one shot.

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Enrich YouTube detail endpoint + add transcript download | 2-3 | feature | sonnet | builder |
| T2: Create local `fetch_video.py` CLI script | 1-2 | feature | sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| video-builder-1 | builder | sonnet | API endpoint enrichment |
| video-builder-2 | builder | sonnet | CLI script creation |
| video-validator-1 | validator-heavy | sonnet | Wave validation |

## Execution Waves

### Wave 1 (parallel)

**T1: Enrich YouTube API endpoints** [sonnet] — video-builder-1

Modify `api/menos/routers/youtube.py` to:

1. **Enrich `GET /youtube/{video_id}`** — Replace `YouTubeVideoInfo` with a richer response model (`YouTubeVideoDetail`) that includes:
   - `video_id`, `content_id` (the SurrealDB content id), `title`
   - `channel_title`, `channel_id`, `duration_seconds`, `published_at`, `view_count`, `like_count`
   - `transcript` — full transcript text (from MinIO `youtube/{video_id}/transcript.txt`)
   - `summary` — from `metadata.unified_result.summary`
   - `tags` — from `metadata.unified_result.tags`
   - `topics` — list of topic names from `metadata.unified_result.topics`
   - `entities` — list of entity names from `metadata.unified_result.additional_entities`
   - `quality_tier` — from `metadata.unified_result.tier`
   - `quality_score` — from `metadata.unified_result.quality_score`
   - `description_urls` — from MinIO `metadata.json` description_urls field (already in SurrealDB metadata if available, or fetch from MinIO metadata.json)
   - `chunk_count`
   - `processing_status`

2. **Add `GET /youtube/{video_id}/transcript`** — Returns raw transcript text with `text/plain` content type. Uses `Response(content=..., media_type="text/plain")`. Simple: fetch from MinIO, return bytes. 404 if not found.

Lookup strategy: Query SurrealDB for content with `metadata.video_id == {video_id}` (existing pattern in the router). Use the content record's `file_path` to fetch transcript from MinIO.

For the unified_result fields, extract from `content.metadata.unified_result` dict (already stored by the pipeline orchestrator in `update_content_processing_result`).

**Acceptance Criteria:**
- `GET /youtube/{video_id}` returns full transcript, pipeline results, YouTube metadata
- `GET /youtube/{video_id}/transcript` returns raw text/plain transcript
- Both endpoints return 404 with proper error for unknown video_id
- Existing `GET /youtube` list endpoint and `POST /youtube/ingest` are unchanged
- New response model is documented with Pydantic BaseModel
- Unit tests cover: (a) rich detail response with all fields, (b) transcript-only endpoint, (c) 404 for missing video, (d) video with no pipeline results yet (fields should be None)

**Files to modify:**
- `api/menos/routers/youtube.py` (main changes)
- `api/tests/unit/test_youtube_router.py` or similar (new test file)

---

**T2: Create local `fetch_video.py` CLI script** [sonnet] — video-builder-2

Create `api/scripts/fetch_video.py` — a CLI tool to fetch video transcript + metadata from the menos API for local use.

```
Usage:
  PYTHONPATH=. uv run python scripts/fetch_video.py VIDEO_ID [options]
  PYTHONPATH=. uv run python scripts/fetch_video.py Q7r--i9lLck
  PYTHONPATH=. uv run python scripts/fetch_video.py Q7r--i9lLck --transcript-only
  PYTHONPATH=. uv run python scripts/fetch_video.py Q7r--i9lLck --save /tmp/
```

The script should:

1. Accept a YouTube video ID (11-char ID or full URL, extract ID from URL)
2. Call `GET /api/v1/youtube/{video_id}` with RFC 9421 signed request (use `menos.client.signer.RequestSigner` and `menos.config.settings.api_base_url`)
3. Display formatted output to stdout:
   - Title, channel, duration, views
   - Summary (from pipeline)
   - Tags, topics, entities, quality tier/score
   - Full transcript (or truncated with `--preview` flag)
4. Options:
   - `--transcript-only` — only output the raw transcript (calls `/youtube/{video_id}/transcript`)
   - `--save DIR` — save transcript.txt and metadata.json to the given directory
   - `--json` — output everything as JSON for piping
   - `--preview` — show first 2000 chars of transcript instead of full

Follow the same patterns as existing scripts (e.g., `signed_request.py`): use `menos.client.signer.RequestSigner`, `menos.config.settings` for API URL, `argparse` for CLI, UTF-8 output handling.

**Acceptance Criteria:**
- Script fetches and displays video data using signed requests
- `--transcript-only` outputs raw transcript text
- `--save DIR` writes `{video_id}_transcript.txt` and `{video_id}_metadata.json`
- `--json` outputs structured JSON
- Proper error handling for 404 / connection errors
- Works on Windows (UTF-8 stdout handling)

**Files to create:**
- `api/scripts/fetch_video.py`

### Wave 1 Validation
- V1: Validate wave 1 [sonnet] — video-validator-1, blockedBy: [T1, T2]
  - Run `cd api && uv run pytest tests/unit/ -v` — all tests pass
  - Run `cd api && uv run ruff check menos/ scripts/` — no lint errors
  - Verify new endpoint models have proper type hints
  - Verify script follows existing patterns (argparse, signer, config)

## Dependency Graph
Wave 1: T1, T2 (parallel) → V1
