---
created: 2026-02-11
completed: 2026-02-11
---

# Team Plan: Wire Entity Extraction into Ingestion (Phase 1)

## Objective
Wire the existing, fully-tested entity extraction pipeline (`EntityResolutionService`) into YouTube ingestion and content upload as a background task. This is Phase 1 of the unified pipeline — ship what exists, validate with real content, then optimize in Phase 2 (LLM merge).

## Background

Design decisions from brainstorming session established a unified pipeline vision:
1. Single LLM Pass (classification + entity extraction merged) — **deferred to Phase 2**
2. Hybrid Knowledge Graph (flat labels + rich entity nodes) — **enabled by this phase**
3. Link extraction for all content types — **deferred to Phase 2**
4. Interest profile as derived view — **deferred to Phase 2**

**Phase 1 scope**: Wire entity extraction alongside existing classification. Both run as separate background tasks. The entity extraction pipeline is fully built and tested (1790+ lines of production code, 2000+ lines of tests) — it just needs connecting to the routers.

## Code Assessment

Ready to wire (all fully implemented and tested):
- `entity_resolution.py` (372 lines) — Orchestrates the 5-stage pipeline
- `entity_extraction.py` (439 lines) — LLM-based topic + entity extraction
- `url_detector.py` (144 lines) — GitHub, arXiv, DOI, PyPI, npm
- `keyword_matcher.py` (238 lines) — Cached keyword + fuzzy entity matching
- `normalization.py` (105 lines) — Name normalization, dedup, boundary matching
- Entity fetchers: `github.py`, `arxiv.py`, `semantic_scholar.py`
- Schema: `entity` + `content_entity` tables already migrated
- Content field: `entity_extraction_status` already exists in schema

**Nothing new to build** — only wiring + DI factory + tests for the wiring.

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic, pytest)
- **Test command**: `cd api && uv run pytest`
- **Lint command**: `cd api && uv run ruff check menos/ scripts/ tests/ && uv run ruff format --check menos/ scripts/ tests/`
- **Working directory**: All commands run from `api/`

## Files to Create
- `api/tests/unit/test_entity_extraction_wiring.py` — Tests for background task wiring
- `api/tests/integration/test_entity_extraction_integration.py` — Integration tests for router-level wiring

## Files to Modify
- `api/menos/services/di.py` — Add `get_entity_resolution_service()` DI factory
- `api/menos/routers/youtube.py` — Add entity extraction background task after classification
- `api/menos/routers/content.py` — Add entity extraction background task for uploads
- `api/menos/services/storage.py` — Add `update_content_entity_extraction_status()` if not already present

## Files NOT to Modify
- `api/menos/services/entity_resolution.py` — Already complete, do not change
- `api/menos/services/entity_extraction.py` — Already complete, do not change
- `api/menos/services/classification.py` — Classification stays as-is
- Any docs — documentation updates deferred until Phase 2

## Team Members
| Name | Agent | Model | Role |
|------|-------|-------|------|
| wire-builder | builder | sonnet | Write tests, implement DI + wiring |
| wire-validator | validator | haiku | Run lints, tests, verify |

## Tasks

### Task 1: Write tests for entity extraction wiring (TDD first)
- **Owner**: wire-builder
- **Blocked By**: none
- **Description**:
  Write tests BEFORE implementation (TDD). These tests will initially fail.

  **1. Read existing test patterns first:**
  - `api/tests/unit/test_classification.py` — how classification background task is tested
  - `api/tests/integration/test_youtube.py` — how YouTube ingest integration tests work
  - `api/tests/unit/test_entity_resolution.py` — mock setup for EntityResolutionService

  **2. Create `api/tests/unit/test_entity_extraction_wiring.py`:**

  Test that the YouTube router launches entity extraction as a background task:
  - `test_ingest_video_triggers_entity_extraction` — after ingest, entity extraction task is created
  - `test_entity_extraction_sets_status_pending` — status is set to "pending" before extraction starts
  - `test_entity_extraction_sets_status_completed` — on success, status updated to "completed"
  - `test_entity_extraction_sets_status_failed` — on LLM/resolution failure, status set to "failed"
  - `test_entity_extraction_does_not_block_response` — ingest response returns before extraction completes
  - `test_entity_extraction_receives_correct_params` — content_id, content_text, content_type, title, description_urls all passed correctly
  - `test_entity_extraction_skipped_when_disabled` — if `entity_extraction_enabled=False` in settings, no task created

  Test the content upload router similarly:
  - `test_content_upload_triggers_entity_extraction` — upload triggers background extraction
  - `test_content_upload_entity_extraction_disabled` — respects enabled flag

  **Mock pattern to follow** (from existing classification tests):
  - Mock `EntityResolutionService.process_content()` as `AsyncMock`
  - Mock `SurrealDBRepository` methods
  - Use the `app_with_keys` fixture pattern from conftest.py

  **3. Create `api/tests/integration/test_entity_extraction_integration.py`:**
  - `test_ingest_video_calls_entity_resolution_process_content` — end-to-end mock verifying the full call chain

- **Acceptance Criteria**:
  - [ ] Test files created with clear test names
  - [ ] Tests follow existing patterns from test_classification.py
  - [ ] Tests cover: happy path, failure, disabled, param passing
  - [ ] Tests initially FAIL (TDD — no implementation yet)
  - [ ] `uv run ruff check tests/` passes on new test files

### Task 2: Add DI factory for EntityResolutionService
- **Owner**: wire-builder
- **Blocked By**: Task 1
- **Description**:
  Add dependency injection factory to `api/menos/services/di.py`.

  **1. Read `di.py` first** to understand the existing pattern:
  - How `get_classification_service()` is built (it assembles LLM provider, interest provider, repo, settings)
  - How `get_surreal_repo()`, `get_minio_storage()` work
  - The provider selection logic (classification_provider setting → LLM provider instance)

  **2. Add `get_entity_resolution_service()` factory:**

  `EntityResolutionService.__init__()` needs:
  - `repository: SurrealDBRepository` — from `get_surreal_repo()`
  - `extraction_service: EntityExtractionService` — needs its own LLM provider (uses `entity_extraction_provider` + `entity_extraction_model` from settings)
  - `keyword_matcher: EntityKeywordMatcher` — instantiate fresh
  - `settings: Settings` — from `get_settings()`
  - `url_detector: URLDetector` — instantiate fresh
  - `sponsored_filter: SponsoredFilter | None` — check if this exists or is optional
  - `github_fetcher: GitHubFetcher | None` — instantiate if `settings.entity_fetch_external_metadata`
  - `arxiv_fetcher: ArxivFetcher | None` — instantiate if `settings.entity_fetch_external_metadata`

  Read `EntityResolutionService.__init__()` in `entity_resolution.py` to confirm exact parameters.
  Read `EntityExtractionService.__init__()` in `entity_extraction.py` for its LLM provider needs.

  **3. Build the LLM provider for entity extraction:**
  The entity extraction uses its own provider settings (`entity_extraction_provider`, `entity_extraction_model`). Follow the same provider-selection pattern used for classification in `get_classification_service()`. Check `config.py` for the settings field names.

  **4. Register as a FastAPI dependency** that can be used with `Depends()` in routers.

- **Acceptance Criteria**:
  - [ ] `get_entity_resolution_service()` function in di.py
  - [ ] Correctly assembles all 8 dependencies
  - [ ] Uses entity_extraction_provider/model settings (not classification settings)
  - [ ] Handles optional fetchers (GitHub, arXiv) based on settings
  - [ ] `uv run ruff check menos/services/di.py` passes

### Task 3: Wire entity extraction into YouTube router
- **Owner**: wire-builder
- **Blocked By**: Task 2
- **Description**:
  Add entity extraction as a second background task in the YouTube ingest endpoint.

  **1. Read `api/menos/routers/youtube.py` carefully:**
  - Understand the `_classify_background()` closure pattern (how it captures services, handles errors, updates status)
  - Understand when it is triggered (after content creation, as fire-and-forget)
  - Note the `classification_enabled` check that gates the task

  **2. Add `_extract_entities_background()` closure:**
  Follow the EXACT same pattern as `_classify_background()`:
  ```python
  async def _extract_entities_background():
      try:
          await surreal_repo.update_content_entity_extraction_status(content_id, "pending")
          result = await entity_resolution_service.process_content(
              content_id=content_id,
              content_text=transcript_text,  # or full_text
              content_type="youtube",
              title=title,
              description_urls=description_urls,  # from YouTube metadata
          )
          await surreal_repo.update_content_entity_extraction_status(content_id, "completed")
      except Exception as e:
          logger.error(f"Entity extraction failed for {content_id}: {e}")
          await surreal_repo.update_content_entity_extraction_status(content_id, "failed")
  ```

  **3. Launch as fire-and-forget task:**
  Add after the classification task launch, gated by `settings.entity_extraction_enabled`:
  ```python
  if settings.entity_extraction_enabled:
      task = asyncio.create_task(_extract_entities_background())
      background_tasks.add(task)
      task.add_done_callback(background_tasks.discard)
  ```

  **4. Pass `description_urls`:**
  Extract URLs from YouTube metadata (the video description URLs). Check how metadata is structured — look for `metadata.description_urls` or similar field. If not readily available, extract from `metadata.get("description", "")` using the URLDetector.

  **5. Add `entity_resolution_service` as a dependency:**
  Import `get_entity_resolution_service` from di.py, add as `Depends()` parameter to `ingest_video()`.

  **6. Do NOT modify the existing classification background task.** It stays as-is. Both tasks run independently in parallel.

  **7. Apply same pattern to `upload_transcript()` endpoint** if it exists in this router.

- **Acceptance Criteria**:
  - [ ] `_extract_entities_background()` follows same pattern as `_classify_background()`
  - [ ] Entity extraction launched as fire-and-forget task
  - [ ] Gated by `settings.entity_extraction_enabled`
  - [ ] description_urls passed from YouTube metadata
  - [ ] Status updates: pending → completed/failed
  - [ ] Existing classification task UNCHANGED
  - [ ] `uv run ruff check menos/routers/youtube.py` passes

### Task 4: Wire entity extraction into content router
- **Owner**: wire-builder
- **Blocked By**: Task 2
- **Description**:
  Add entity extraction as a background task for content uploads.

  **1. Read `api/menos/routers/content.py`:**
  - Find the upload endpoint (likely `POST /api/v1/content`)
  - Check if there is already a classification background task here
  - Understand what content_text is available after upload

  **2. Add entity extraction background task:**
  Same pattern as YouTube router:
  - Gate by `settings.entity_extraction_enabled`
  - Create `_extract_entities_background()` closure
  - Launch as fire-and-forget
  - Status updates: pending → completed/failed

  **3. Content text for extraction:**
  The uploaded file content is the text to pass. For markdown files, this includes the full text. For other types, use whatever text representation is stored.

  **4. No `description_urls` for general content uploads** — pass `None`.

  **5. Keep existing inline link extraction for markdown unchanged.** Entity extraction adds entity detection on top, not replacing link extraction.

- **Acceptance Criteria**:
  - [ ] Entity extraction background task added to content upload
  - [ ] Gated by settings flag
  - [ ] Same fire-and-forget pattern
  - [ ] Existing link extraction unchanged
  - [ ] `uv run ruff check menos/routers/content.py` passes

### Task 5: Add storage helper (if needed)
- **Owner**: wire-builder
- **Blocked By**: none (can run with Task 2)
- **Description**:
  Check if `update_content_entity_extraction_status()` already exists in `storage.py`.

  **1. Read `api/menos/services/storage.py`:**
  - Search for `entity_extraction_status` references
  - Check if there is already an `update_content_entity_extraction_status()` method
  - Look at `update_content_classification_status()` for the pattern

  **2. If the method does NOT exist, add it:**
  ```python
  async def update_content_entity_extraction_status(
      self, content_id: str, status: str
  ) -> None:
      """Update entity extraction status on content record."""
      await self.db.query(
          "UPDATE type::thing('content', $id) SET "
          "entity_extraction_status = $status, "
          "entity_extraction_at = time::now(), "
          "updated_at = time::now()",
          {"id": content_id, "status": status},
      )
  ```
  Follow the exact pattern from `update_content_classification_status()`.

  **3. If it already exists**, skip this task — just verify it works correctly.

- **Acceptance Criteria**:
  - [ ] `update_content_entity_extraction_status()` method exists and works
  - [ ] Follows same pattern as classification status update
  - [ ] `uv run ruff check menos/services/storage.py` passes

### Task 6: Validate implementation
- **Owner**: wire-validator
- **Blocked By**: Task 1, Task 3, Task 4, Task 5
- **Description**: Run full validation suite
- **Acceptance Criteria**:
  - [ ] `cd api && uv run pytest tests/unit/ -v` — all unit tests pass (including new wiring tests)
  - [ ] `cd api && uv run pytest tests/integration/ -v` — all integration tests pass
  - [ ] `cd api && uv run ruff check menos/ scripts/ tests/` — no lint errors
  - [ ] `cd api && uv run ruff format --check menos/ scripts/ tests/` — formatting OK
  - [ ] Entity extraction services NOT modified (entity_resolution.py, entity_extraction.py, url_detector.py, keyword_matcher.py unchanged)
  - [ ] Classification service NOT modified (classification.py unchanged)
  - [ ] No debug statements or hardcoded secrets
  - [ ] `entity_extraction_enabled` setting correctly gates the feature

## Dependency Graph
```
Task 1 (write tests - TDD)  ──→ Task 3 (youtube wiring) ──→ Task 6 (validate)
                             ──→ Task 4 (content wiring) ──→
Task 2 (DI factory)          ──→ Task 3
                             ──→ Task 4
Task 5 (storage helper)      ──→ Task 3
                             ──→ Task 4
```

Tasks 1, 2, and 5 can run in parallel.
Tasks 3 and 4 can run in parallel after 1, 2, 5 complete.
Task 6 runs last.

## Phase 2 (Future — Not In Scope)

After Phase 1 is deployed and validated with real content:

1. **Design combined prompt** — merge classification + entity extraction into one LLM call
2. **Test prompt quality** — compare combined output against separate calls on real content
3. **Create UnifiedPipelineService** — delegates to existing services, replaces both background tasks
4. **Add link extraction to pipeline** — Phase 1 of deterministic pre-enrichment for all content
5. **Remove interest profile bias** — classification becomes unbiased, interest profile becomes derived view
6. **Schema cleanup** — replace separate status fields with unified `processing_status`
7. **Update documentation** — spec, ingest-pipeline.md, schema.md, rules files
