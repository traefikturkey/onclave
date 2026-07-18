# Team Plan: Close Coverage Gaps (74% → 90%+)

## Objective
Add integration tests for all uncovered router endpoints and unit tests for uncovered service paths. No restructuring needed — the codebase already uses FastAPI dependency injection correctly. Existing `conftest.py` provides mock fixtures and `AuthedTestClient` for signed requests. All gaps are testable without code changes.

## Design Analysis: No Restructuring Needed

After reviewing all gap files, the architecture is already test-friendly:

1. **Routers use `Depends()`** — all external services are injected via FastAPI DI, and `conftest.py` already overrides them with mocks (`mock_surreal_repo`, `mock_minio_storage`, `mock_embedding_service`).
2. **Services accept constructor args** — `LLMService(base_url, model)`, `YouTubeMetadataService(api_key)` — easy to mock.
3. **`AuthedTestClient`** already handles RFC 9421 signing — just use `authed_client` fixture.
4. **The only missing pieces are test cases**, not testability infrastructure.

The one gap that *could* benefit from restructuring is `routers/youtube.py` (25% coverage, 136 statements), where `ingest_video` creates `ChunkingService` inline. But this is a 1-line instantiation — mocking `ChunkingService` at the module level is simpler than refactoring.

## Project Context
- **Language**: Python 3.12+, FastAPI, Pydantic v2
- **Test command**: `make test`
- **Lint command**: `make lint`

## Coverage Gaps (by priority)

| File | Current | Miss | Priority |
|------|---------|------|----------|
| `routers/youtube.py` | 25% | 102 stmts | High — largest gap |
| `services/youtube_metadata.py` | 21% | 60 stmts | Medium — already tested via refetch script mocks, needs unit tests for helpers |
| `services/di.py` | 42% | 14 stmts | Low — DI factory functions, covered implicitly |
| `services/llm.py` | 43% | 8 stmts | Low — thin httpx wrapper |
| `routers/content.py` | 52% | 20 stmts | High — CRUD happy paths missing |
| `routers/search.py` | 62% | 18 stmts | Medium — search logic untested |
| `services/youtube.py` | 64% | 19 stmts | Medium — fetch_transcript untested |
| `routers/health.py` | 79% | 8 stmts | Low — check_* helpers |
| `auth/signature.py` | 88% | 10 stmts | Low — edge cases |
| `services/storage.py` | 87% | 14 stmts | Low — update_content, delete_chunks |

## Team Members
| Name | Agent | Role |
|------|-------|------|
| router-builder | general-purpose (sonnet) | Write integration tests for routers |
| service-builder | general-purpose (sonnet) | Write unit tests for services |
| validator | general-purpose (haiku) | Verify lint, tests, coverage |

## Tasks

### Task 1: Integration tests for content router
- **Owner**: router-builder
- **Blocked By**: none
- **Description**: Add tests to `api/tests/integration/test_content.py` covering the happy paths that are currently only auth-tested:

  **TestContentCRUD** (use `authed_client` + existing mocks):
  - `test_list_content_returns_items` — mock `list_content` returns items, verify response structure
  - `test_list_content_with_type_filter` — pass `content_type` query param
  - `test_list_content_with_pagination` — pass `offset` and `limit`
  - `test_get_content_found` — mock `get_content` returns item
  - `test_get_content_not_found` — mock returns None → error response
  - `test_create_content_uploads_and_stores` — POST multipart file, verify minio.upload + surreal.create called
  - `test_delete_content_found` — mock get_content returns item, verify minio.delete + surreal.delete_chunks + surreal.delete_content
  - `test_delete_content_not_found` — mock returns None → error response

- **Acceptance Criteria**:
  - [ ] All new tests pass
  - [ ] `routers/content.py` coverage ≥ 95%
- **Verification Command**: `make test`

### Task 2: Integration tests for youtube router
- **Owner**: router-builder
- **Blocked By**: none
- **Description**: Create `api/tests/integration/test_youtube.py` with tests for all 4 youtube endpoints.

  Need to add mock overrides for `get_youtube_service`, `get_llm_service`, `get_youtube_metadata_service` in conftest (or per-test). Add these dependency overrides in the test file using `app_with_keys` fixture's app.

  **TestYouTubeIngest** (mock youtube_service, minio, surreal, embedding, llm, metadata_service):
  - `test_ingest_video_happy_path` — POST `/api/v1/youtube/ingest` with URL, verify transcript fetched, stored, chunks created, response correct
  - `test_ingest_video_with_metadata` — metadata_service returns metadata, verify title uses yt metadata
  - `test_ingest_video_metadata_fetch_fails` — metadata_service raises, video still ingests with fallback title
  - `test_ingest_video_embedding_fails` — embedding raises, chunk still created with None embedding
  - `test_ingest_video_summary_generated` — LLM returns summary, verify stored in minio
  - `test_ingest_video_summary_fails` — LLM raises, response still succeeds with summary=None
  - `test_ingest_video_no_embeddings` — `generate_embeddings=False`, no chunks created

  **TestYouTubeUpload**:
  - `test_upload_transcript_happy_path` — POST with video_id + transcript text
  - `test_upload_transcript_with_timestamps` — timestamped_text provided
  - `test_upload_transcript_no_embeddings` — `generate_embeddings=False`

  **TestYouTubeGetVideo**:
  - `test_get_video_found` — video exists in list, returns info with chunks
  - `test_get_video_not_found` — no matching video_id
  - `test_get_video_chunk_error` — get_chunks raises, chunk_count=0
  - `test_get_video_transcript_unavailable` — minio download raises, preview fallback

  **TestYouTubeListVideos**:
  - `test_list_videos_returns_items` — multiple videos
  - `test_list_videos_empty` — no items
  - `test_list_videos_chunk_error` — get_chunks raises for one item, continues

- **Acceptance Criteria**:
  - [ ] All new tests pass
  - [ ] `routers/youtube.py` coverage ≥ 90%
- **Verification Command**: `make test`

### Task 3: Integration tests for search and health routers
- **Owner**: router-builder
- **Blocked By**: none
- **Description**: Add tests for search happy path and health check helpers.

  **In `api/tests/integration/test_content.py`** or new file `test_search.py`:

  **TestSearchEndpoint** (use `authed_client`, mock surreal_repo.db.query + embedding_service):
  - `test_search_returns_results` — mock chunks with embeddings, mock content list, verify ranked results
  - `test_search_empty_chunks` — no chunks → empty results
  - `test_search_handles_record_id` — chunk content_id has record_id attribute

  **In `api/tests/integration/test_health.py`**:

  **TestReadyEndpoint** (mock check functions):
  - `test_ready_all_ok` — mock all checks return "ok"
  - `test_ready_degraded` — mock one check returns error
  - `test_check_surrealdb_success` — mock Surreal, verify returns "ok"
  - `test_check_surrealdb_failure` — mock raises, returns error string
  - `test_check_minio_success` — mock Minio, returns "ok"
  - `test_check_minio_failure` — mock raises
  - `test_check_ollama_success` — mock httpx, returns "ok"
  - `test_check_ollama_failure` — mock raises

- **Acceptance Criteria**:
  - [ ] All new tests pass
  - [ ] `routers/search.py` coverage ≥ 90%
  - [ ] `routers/health.py` coverage ≥ 95%
- **Verification Command**: `make test`

### Task 4: Unit tests for service gaps
- **Owner**: service-builder
- **Blocked By**: none
- **Description**: Add unit tests for uncovered service code.

  **In `api/tests/unit/test_youtube_metadata.py`** (new file):
  - `test_extract_urls_from_text` — multiple URLs
  - `test_extract_urls_cleans_trailing_punctuation`
  - `test_extract_urls_deduplicates`
  - `test_extract_urls_empty_text`
  - `test_parse_duration_hours_minutes_seconds`
  - `test_parse_duration_minutes_only`
  - `test_parse_duration_invalid`
  - `test_format_duration_with_hours`
  - `test_format_duration_minutes_seconds`
  - `test_format_duration_invalid`
  - `test_metadata_service_init_uses_settings`
  - `test_metadata_service_requires_api_key`
  - `test_fetch_metadata_happy_path` — mock google API client
  - `test_fetch_metadata_video_not_found`
  - `test_fetch_metadata_safe_returns_tuple`
  - `test_metadata_to_dict`

  **In `api/tests/unit/test_youtube.py`** (add to existing):
  - `test_fetch_transcript_success` — mock YouTubeTranscriptApi
  - `test_fetch_transcript_video_unavailable`
  - `test_fetch_transcript_disabled`
  - `test_fetch_transcript_not_found`
  - `test_fetch_transcript_with_proxy`
  - `test_service_init_with_proxy`

  **In `api/tests/unit/test_llm.py`** (new file):
  - `test_llm_service_init`
  - `test_generate_success` — mock httpx
  - `test_generate_http_error`
  - `test_get_llm_service_factory`

  **In `api/tests/unit/test_storage.py`** (add to existing):
  - `test_update_content` — verify update call
  - `test_update_content_failure` — raises RuntimeError
  - `test_delete_chunks` — verify query call
  - `test_download_error` — S3Error → RuntimeError
  - `test_delete_error` — S3Error → RuntimeError

  **In `api/tests/unit/test_di.py`** (new file):
  - `test_get_storage_context` — mock Minio, Surreal, verify yield
  - `test_get_minio_storage` — verify creates MinIOStorage
  - `test_get_surreal_repo` — verify creates and connects

- **Acceptance Criteria**:
  - [ ] All new tests pass
  - [ ] `services/youtube_metadata.py` coverage ≥ 85%
  - [ ] `services/youtube.py` coverage ≥ 90%
  - [ ] `services/llm.py` coverage ≥ 90%
  - [ ] `services/storage.py` coverage ≥ 95%
  - [ ] `services/di.py` coverage ≥ 85%
- **Verification Command**: `make test`

### Task 5: Validate all tests and coverage
- **Owner**: validator
- **Blocked By**: Task 1, Task 2, Task 3, Task 4
- **Description**: Run full validation suite
- **Acceptance Criteria**:
  - [ ] `make lint` passes
  - [ ] `make test` passes with zero warnings
  - [ ] Overall coverage ≥ 90%
  - [ ] No file below 80% coverage (excluding `__init__.py`)
  - [ ] No debug statements or hardcoded secrets
- **Verification Command**: `make lint && cd api && uv run pytest --cov=menos --cov=scripts --cov-report=term-missing -v`

## Dependency Graph
```
Task 1 (content router) ──────┐
Task 2 (youtube router) ──────┼──→ Task 5 (validate)
Task 3 (search+health router) ┤
Task 4 (service unit tests) ──┘
```
