---
created: 2026-02-11
completed: 2026-02-11
---

# Team Plan: API Data Endpoints & Skill Update

## Objective

Add missing read-only API endpoints that expose data already stored in SurrealDB/MinIO but not currently accessible via HTTP. Then update the `youtube-transcript` skill to leverage both the new and existing endpoints for efficient video data access.

Currently:
- `GET /content/{id}` returns basic metadata but omits pipeline results (unified_result)
- No way to download raw files for non-YouTube content
- No way to get chunks for a content item
- No way to get entities linked to a content item (reverse exists)
- No aggregate stats for content processing status
- The `youtube-transcript` skill references local file paths instead of the API

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/ scripts/`

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Content file download endpoint | 2 | feature | sonnet | builder |
| T2: Content entities + chunks + stats endpoints | 3 | feature | sonnet | builder |
| T3: Enrich GET /content/{id} with pipeline results | 2 | feature | sonnet | builder |
| T4: Update youtube-transcript skill | 1 | mechanical | haiku | builder-light |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| api-builder-1 | builder | sonnet | Content download endpoint |
| api-builder-2 | builder | sonnet | Entities/chunks/stats endpoints |
| api-builder-3 | builder | sonnet | Enrich content detail |
| skill-builder | builder-light | haiku | Skill file update |
| api-validator-1 | validator-heavy | sonnet | Wave 1 validation |
| api-validator-2 | validator-heavy | sonnet | Wave 2 validation |

## Execution Waves

### Wave 1 (parallel)

**T1: Content file download endpoint** [sonnet] — api-builder-1

Add `GET /api/v1/content/{content_id}/download` to `api/menos/routers/content.py`.

Downloads the raw file from MinIO for any content item. Uses the `file_path` from the content record to call `minio_storage.download()`.

Implementation:
1. Look up content by ID via `surreal_repo.get_content(content_id)`
2. Return 404 via HTTPException if not found
3. Download bytes via `minio_storage.download(content.file_path)`
4. Return `Response(content=data, media_type=content.mime_type)` with a `Content-Disposition` header for the filename
5. Handle MinIO download errors gracefully (return 404 if file missing)

Response: Raw file bytes with appropriate `Content-Type` and `Content-Disposition: attachment; filename="..."`.

**Acceptance Criteria:**
- `GET /content/{content_id}/download` returns raw file with correct mime_type
- Returns 404 for unknown content_id
- Returns 404 if MinIO file is missing
- Content-Disposition header set with filename extracted from file_path
- Unit tests: happy path, content not found, MinIO error

**Files to modify:**
- `api/menos/routers/content.py`
- `api/tests/unit/test_content_download.py` (new)

---

**T2: Content entities, chunks, and stats endpoints** [sonnet] — api-builder-2

Add three new sub-endpoints to the content router in `api/menos/routers/content.py`:

#### 2a. `GET /api/v1/content/{content_id}/entities`

Returns entities linked to this content item with edge metadata.

Implementation:
1. Verify content exists (404 if not)
2. Call `surreal_repo.get_entities_for_content(content_id)` — returns `list[tuple[EntityModel, ContentEntityEdge]]`
3. Return list of `{id, name, entity_type, edge_type, confidence}`

Response model:
```python
class ContentEntityResponse(BaseModel):
    id: str
    name: str
    entity_type: str
    edge_type: str
    confidence: float | None = None

class ContentEntitiesListResponse(BaseModel):
    items: list[ContentEntityResponse]
    total: int
```

#### 2b. `GET /api/v1/content/{content_id}/chunks`

Returns chunks for a content item.

Implementation:
1. Verify content exists (404 if not)
2. Call `surreal_repo.get_chunks(content_id)` — returns `list[ChunkModel]`
3. Return chunk text and index, exclude embeddings by default
4. Add `?include_embeddings=true` query param to optionally include them

Response model:
```python
class ContentChunkResponse(BaseModel):
    id: str | None = None
    chunk_index: int
    text: str
    embedding: list[float] | None = None

class ContentChunksListResponse(BaseModel):
    items: list[ContentChunkResponse]
    total: int
```

#### 2c. `GET /api/v1/content/stats`

Returns aggregate counts by processing_status and content_type.

Implementation:
1. Run SurrealQL aggregation queries (two queries):
   - `SELECT count() AS count, metadata.processing_status AS status FROM content GROUP BY metadata.processing_status`
   - `SELECT count() AS count, content_type FROM content GROUP BY content_type`
2. Return structured response

Response model:
```python
class ContentStatsResponse(BaseModel):
    total: int
    by_status: dict[str, int]
    by_content_type: dict[str, int]
```

**IMPORTANT route ordering:** The `/stats` endpoint MUST be defined BEFORE `/{content_id}` routes in the router, otherwise FastAPI will treat "stats" as a content_id. Place it right after the `GET ""` list endpoint.

**Acceptance Criteria:**
- `/content/{id}/entities` returns entities with edge metadata, 404 for missing content
- `/content/{id}/chunks` returns chunks without embeddings by default, with embeddings when requested
- `/content/stats` returns aggregate counts
- Unit tests for all three endpoints (happy path + 404 where applicable)

**Files to modify:**
- `api/menos/routers/content.py`
- `api/menos/services/storage.py` (add `get_content_stats` method)
- `api/tests/unit/test_content_endpoints.py` (new)

---

**T3: Enrich GET /content/{id} with pipeline results** [sonnet] — api-builder-3

Currently `GET /content/{id}` returns a raw dict with basic metadata. Enrich it to include pipeline results and use a proper Pydantic response model.

Implementation:
1. Create `ContentDetailResponse` model:
```python
class ContentDetailResponse(BaseModel):
    id: str
    content_type: str
    title: str | None = None
    description: str | None = None
    mime_type: str
    file_size: int
    file_path: str
    tags: list[str] = []
    created_at: str | None = None
    updated_at: str | None = None
    processing_status: str | None = None
    summary: str | None = None
    quality_tier: str | None = None
    quality_score: int | None = None
    pipeline_tags: list[str] = []
    topics: list[str] = []
    entities: list[str] = []
    metadata: dict | None = None
```

2. Modify `get_content()` endpoint to use this model
3. Extract pipeline fields from `metadata.unified_result` (same pattern as youtube detail endpoint)
4. Return proper 404 via HTTPException instead of `{"error": "Content not found"}`
5. Also fix `update_content()` and `delete_content()` to use HTTPException for 404

**Acceptance Criteria:**
- `GET /content/{id}` returns enriched response with pipeline fields
- Returns proper HTTP 404 status code (not 200 with error dict)
- Video with no pipeline results returns None for pipeline fields
- `PATCH` and `DELETE` also return proper 404 status codes
- Unit tests: happy path with pipeline results, no pipeline results, 404

**Files to modify:**
- `api/menos/routers/content.py`
- `api/tests/unit/test_content_detail.py` (new)

### Wave 1 Validation
- V1: Validate wave 1 [sonnet] — api-validator-1, blockedBy: [T1, T2, T3]
  - Run `cd api && uv run pytest tests/unit/ -v` — all tests pass, zero warnings
  - Run `cd api && uv run ruff check menos/ scripts/` — no lint errors
  - Verify `/content/stats` route is defined BEFORE `/{content_id}` routes
  - Verify all new endpoints use HTTPException for 404 (not dict responses)
  - Verify all new response models have proper type hints
  - Check for any import conflicts between the three builders modifying content.py

### Wave 2

**T4: Update youtube-transcript skill** [haiku] — skill-builder, blockedBy: [V1]

Rewrite `C:\Users\mglenn\.dotfiles\claude\skills\youtube-transcript\SKILL.md` to reflect the full menos API as the primary data source instead of local file paths.

The updated skill should:

1. **Remove** all references to `claude/logs/yt/` local file paths — the API is now the primary source
2. **Document available endpoints** for video access:
   - `GET /api/v1/youtube/{video_id}` — full video detail (transcript, pipeline results, metadata)
   - `GET /api/v1/youtube/{video_id}/transcript` — raw transcript text
   - `GET /api/v1/youtube` — list all videos
   - `GET /api/v1/youtube/channels` — list channels
   - `GET /api/v1/content/{content_id}/entities` — entities linked to content
   - `GET /api/v1/content/{content_id}/chunks` — content chunks
   - `GET /api/v1/content/{content_id}/download` — raw file download
   - `GET /api/v1/content/{content_id}` — enriched content detail with pipeline results
   - `POST /api/v1/search/agentic` — semantic search across all content
3. **Document CLI scripts** for local access:
   - `PYTHONPATH=. uv run python scripts/fetch_video.py VIDEO_ID` — fetch video with all data
   - `PYTHONPATH=. uv run python scripts/fetch_video.py VIDEO_ID --transcript-only` — raw transcript
   - `PYTHONPATH=. uv run python scripts/fetch_video.py VIDEO_ID --save DIR` — save locally
   - `PYTHONPATH=. uv run python scripts/fetch_video.py VIDEO_ID --json` — JSON output
   - `PYTHONPATH=. uv run python scripts/signed_request.py GET /api/v1/youtube` — generic signed request
4. **Keep the context efficiency strategy** — use Task(subagent_type=Explore) to analyze transcripts without loading them into main context, but update the pattern to use `fetch_video.py --save` to get files locally first
5. **Update the activation triggers** in frontmatter to include: video_id references, YouTube URLs, mentions of video transcripts/metadata, `/yt` command, fetch_video script usage

The skill file path is: `C:\Users\mglenn\.dotfiles\claude\skills\youtube-transcript\SKILL.md`

**Acceptance Criteria:**
- No references to `claude/logs/yt/` local paths
- All API endpoints documented with method + path + description
- All CLI scripts documented with examples
- Context efficiency strategy preserved and updated
- Activation triggers updated in frontmatter

**Files to modify:**
- `C:\Users\mglenn\.dotfiles\claude\skills\youtube-transcript\SKILL.md`

### Wave 2 Validation
- V2: Validate wave 2 [haiku] — api-validator-2, blockedBy: [T4]
  - Verify skill file has no references to `claude/logs/yt/`
  - Verify all documented endpoints match what was built in Wave 1
  - Verify CLI script examples are accurate
  - Verify SKILL.md frontmatter is valid YAML

## Dependency Graph
Wave 1: T1, T2, T3 (parallel) → V1 → Wave 2: T4 → V2
