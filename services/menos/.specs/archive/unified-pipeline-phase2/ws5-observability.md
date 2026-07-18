---
created: 2026-02-11
completed:
status: blocked
blocked_by: ws3, ws4
parent: plan.md
---

# Team Plan: WS5 — Observability + Retention + Cleanup

## Objective

Add structured logging with correlation IDs, job/stage metrics, audit events, retention
controls, graph endpoint alignment with the unified data model, removal of the min-length
gate, and deletion of all dead legacy code from the dual-task era.

## Depends On

- **WS3** (job model, pipeline_job table, `update_content_processing_status`, `update_content_processing_result`)
- **WS4** (routers rewritten to use unified pipeline, scripts rewritten, legacy call-sites removed from routers)

---

## Current State

### What exists for observability
- `unified_pipeline.py` logs at `logger.info` / `logger.warning` / `logger.error` levels but without correlation IDs or structured fields (lines 327, 381, 387, 393, 400-407).
- `entity_extraction.py` has `ExtractionMetrics` model (models.py:172-180) tracking `total_latency_ms`, `llm_tokens_used` — but these are returned in-memory and not persisted.
- `jobs.py:JobRepository.update_job_status()` auto-sets `started_at`/`finished_at` timestamps (lines 98-155), enabling duration computation — but no code currently computes or logs it.
- `PipelineJob` model has `error_code`, `error_message`, `error_stage` fields (models.py:66-68) — taxonomy structure exists but nothing populates it yet.
- `config.py:75` has `unified_pipeline_max_concurrency: int = 4` — concurrency is configured but not enforced.
- `health.py:22` exposes `app_version` on `/health` — version is surfaced at runtime.

### What is missing
- No correlation ID (e.g., `job_id`) threaded through pipeline log messages.
- No structured log fields (JSON log format, stage timing, token counts).
- No audit events for: full-tier access, reprocess triggers, cancellation, callback delivery.
- No retention/purge mechanism for `pipeline_job` records.
- No min-length gate removal in unified pipeline (it exists only in the legacy `classification.py:179` and `entity_extraction.py:181`).
- No cleanup of dead legacy code after WS4 cutover.
- Graph endpoint (`graph.py`) does NOT reference `classification_status` or `entity_extraction_status` — it purely queries `content` + `link` tables. Alignment work is minimal.

---

## Legacy Code Inventory

Code to remove after WS4 cutover completes. These are the exact functions, methods, fields,
models, files, config keys, and DI wiring that become dead code.

### Storage Methods (storage.py)
| Method | Location | Reason |
|--------|----------|--------|
| `update_content_classification_status()` | `storage.py:984-1003` | Replaced by `update_content_processing_status()` |
| `update_content_classification()` | `storage.py:1005-1036` | Replaced by `update_content_processing_result()` |
| `update_content_extraction_status()` | `storage.py:882-902` | Replaced by `update_content_processing_status()` |
| `get_interest_profile()` | `storage.py:1038-1105` | Only used by `VaultInterestProvider` (legacy classification) |

### Models (models.py)
| Model / Field | Location | Reason |
|---------------|----------|--------|
| `ClassificationResult` | `models.py:183-193` | Replaced by `UnifiedResult` |
| `ClassificationResult.labels` | `models.py:186` | `labels` terminology replaced by `tags` |
| `ExtractionResult` | `models.py:164-169` | Only used by legacy `EntityExtractionService` |
| `ExtractionMetrics` | `models.py:172-180` | Only used by legacy `EntityExtractionService` |

### Services
| File | What to remove | Reason |
|------|----------------|--------|
| `classification.py` (entire file) | `ClassificationService`, `VaultInterestProvider`, `InterestProvider` protocol, `CLASSIFICATION_PROMPT_TEMPLATE`, `_dedup_label`, constants | Replaced by `UnifiedPipelineService`. Note: `VALID_TIERS`, `LABEL_PATTERN`, `_dedup_label` are imported by `unified_pipeline.py` — must migrate these before deleting. |
| `entity_extraction.py` (entire file) | `EntityExtractionService`, `EXTRACTION_PROMPT_TEMPLATE`, helpers | Replaced by unified pipeline. Note: `_confidence_to_float`, `_edge_type_from_string`, `_entity_type_from_string`, `_parse_topic_hierarchy` are imported by `unified_pipeline.py` — must migrate these before deleting. |
| `entity_resolution.py` | Verify if still needed | After WS4, may be called from unified pipeline for entity persistence, or may be folded in. Audit call sites before removing. |

### Routers
| File | What to remove | Reason |
|------|----------------|--------|
| `classification.py` (entire router file) | `ClassifyResponse`, `classify_content` endpoint | Replaced by unified reprocess endpoint (WS4 Task 8a) |

### DI Wiring (di.py)
| Function | Location | Reason |
|----------|----------|--------|
| `get_classification_provider()` | `di.py:250-275` | Dead after classification.py removal |
| `get_classification_service()` | `di.py:278-293` | Dead after classification.py removal |
| `get_entity_extraction_provider()` | `di.py:221-246` | Dead after entity_extraction.py removal |
| `get_entity_resolution_service()` | `di.py:296-321` | Dead if entity_resolution is folded in or no longer DI-wired |

### Config Keys (config.py)
| Key | Location | Reason |
|-----|----------|--------|
| `classification_enabled` | `config.py:78` | Replaced by `unified_pipeline_enabled` |
| `classification_provider` | `config.py:79` | Replaced by `unified_pipeline_provider` |
| `classification_model` | `config.py:80` | Replaced by `unified_pipeline_model` |
| `classification_interest_top_n` | `config.py:82` | Only used by `VaultInterestProvider` |
| `classification_min_content_length` | `config.py:83` | Min-length gate removed (Task 10) |
| `entity_extraction_enabled` | `config.py:67` | Replaced by `unified_pipeline_enabled` |
| `entity_extraction_provider` | `config.py:68` | Replaced by `unified_pipeline_provider` |
| `entity_extraction_model` | `config.py:69` | Replaced by `unified_pipeline_model` |

### Scripts
| Script | Disposition |
|--------|-------------|
| `scripts/classify_content.py` | Rewritten in WS4 Task 8 to use unified pipeline — keep |
| `scripts/reprocess_content.py` | Rewritten in WS4 Task 8 to use unified pipeline |
| `scripts/export_summaries.py` | Rewritten in WS4 Task 8 to use unified result |

### Router References to Legacy Status
| File | Lines | What |
|------|-------|------|
| `youtube.py:54` | `classification_status` field in `YouTubeIngestResponse` | Remove field |
| `youtube.py:194-298` | `_classify_background()`, `_extract_entities_background()` inline tasks | Replaced by unified pipeline job |
| `content.py:229-289` | `_classify_background()` inline task, `update_content_classification_status` calls | Replaced by unified pipeline job |
| `content.py:291-293` | `update_content_extraction_status` call | Replaced by unified pipeline job |

### Imports to Migrate Before Deletion
The unified pipeline currently imports from legacy files:
- From `classification.py`: `LABEL_PATTERN`, `VALID_TIERS`, `_dedup_label` (unified_pipeline.py:15)
- From `entity_extraction.py`: `_confidence_to_float`, `_edge_type_from_string`, `_entity_type_from_string`, `_parse_topic_hierarchy` (unified_pipeline.py:16-21)

These must be moved to a shared location (e.g., inline in `unified_pipeline.py` or a `utils.py`) before the legacy files can be deleted.

---

## Task Breakdowns

### Task 8e: Observability Baseline

**Objective**: Add correlation IDs, structured log fields, stage metrics, and audit events to the unified pipeline.

**Where to add correlation IDs**:
- `unified_pipeline.py:UnifiedPipelineService.process()` — thread `job_id` through all log messages as a structured field
- Each stage within `process()` gets a timing wrapper:
  1. Content truncation (line 333-336)
  2. Tag fetch from DB (lines 339-343)
  3. Pre-detected entity formatting (lines 345-356)
  4. LLM call (lines 373-378)
  5. Response parsing via `parse_unified_response()` (lines 385-393)
  6. Result persistence (after WS4 wires this up)

**What metrics to track**:
- Job duration: computed from `pipeline_job.started_at` to `pipeline_job.finished_at` (already stored by `jobs.py:128-133`)
- Per-stage latency: measure wall-clock time around each stage in `process()`, log as structured fields
- LLM token usage: if the LLM provider returns token counts (check `response` object), log them; otherwise log rough estimate (prompt length + response length)
- Job outcome counts: log on completion with final status, tier, quality_score, tag count, topic count

**Audit events to emit** (structured log entries with `audit=True` marker):
- `audit.full_tier_access`: when verbose/full-tier job data is accessed (WS4 Task 8c endpoint)
- `audit.reprocess_trigger`: when reprocess is requested (WS4 Task 8a endpoint)
- `audit.cancellation`: when cancellation is requested and its outcome (WS4 Task 8g endpoint)
- `audit.callback_delivery`: when callback is sent, with attempt number and success/failure (WS4 Task 8d)

**Error taxonomy**: `PipelineJob.error_code`, `error_message`, `error_stage` fields already exist on the model (models.py:66-68). Populate these from the unified pipeline:
- `error_stage`: one of `truncation`, `tag_fetch`, `llm_call`, `parse`, `persist`
- `error_code`: short machine-readable code (e.g., `LLM_TIMEOUT`, `PARSE_FAILED`, `DB_ERROR`)
- `error_message`: human-readable detail

**Acceptance Criteria**:
- [ ] Every log entry from `unified_pipeline.py` includes `job_id` correlation field
- [ ] Per-stage latency logged as structured fields (e.g., `stage=llm_call latency_ms=1234`)
- [ ] LLM token usage logged when available
- [ ] Audit events emitted for full-tier access, reprocess, cancellation, callback delivery
- [ ] `error_code`, `error_message`, `error_stage` populated on job failure
- [ ] Existing tests updated, new tests for error taxonomy population
- [ ] `ruff check` passes, zero warnings

### Task 8f: Retention/Purge Controls

**Objective**: Implement idempotent purge of old `pipeline_job` records based on data tier and age.

**Purge queries against `pipeline_job` table**:
```sql
-- Compact tier: 6-month retention
DELETE FROM pipeline_job
WHERE data_tier = 'compact'
  AND finished_at != NONE
  AND finished_at < time::now() - 6mo;

-- Full tier: 2-month retention
DELETE FROM pipeline_job
WHERE data_tier = 'full'
  AND finished_at != NONE
  AND finished_at < time::now() - 2mo;
```

**Mechanism**: Idempotent purge function in `jobs.py:JobRepository`:
- `async def purge_expired_jobs() -> dict[str, int]` — returns counts of deleted records per tier
- Called from app startup lifespan handler (same pattern as migration runner in `main.py`)
- Safe to run multiple times (DELETE is idempotent on already-deleted records)
- Logs purge results as structured event

**Acceptance Criteria**:
- [ ] `purge_expired_jobs()` method on `JobRepository`
- [ ] Compact tier records older than 6 months are purged
- [ ] Full tier records older than 2 months are purged
- [ ] Purge runs on app startup (lifespan handler)
- [ ] Purge is idempotent (no errors on empty table or re-runs)
- [ ] Unit test with mocked DB verifying correct queries
- [ ] `ruff check` passes, zero warnings

### Task 9: Graph Endpoint Hard Contract Alignment

**Objective**: Ensure graph endpoint queries work correctly with the unified data model.

**Current state**: `graph.py` does NOT reference `classification_status` or `entity_extraction_status`. It queries `content` table (for nodes) and `link` table (for edges) using `tags`, `content_type`, and `limit` filters. The `GraphNode` response model includes `id`, `title`, `content_type`, `tags`.

**What needs to happen**:
- Verify that `get_graph_data()` in `storage.py:403-469` works correctly after WS3 schema changes (new `processing_status`, `processed_at`, `pipeline_version` fields on content — these are additive and should not break existing queries)
- Optionally add `processing_status` to `GraphNode` response model so the UI can display processing state on nodes
- Ensure `get_neighborhood()` in `storage.py:471-532` continues to work

**This is low-risk**: Graph queries are purely read-only against `content` + `link` tables. The schema changes from WS3 are additive fields. No breaking query changes expected.

**Acceptance Criteria**:
- [ ] Graph endpoint returns correct data after unified pipeline schema changes
- [ ] Optional: `GraphNode` includes `processing_status` field
- [ ] Existing graph tests pass (if any), or add integration test
- [ ] `ruff check` passes, zero warnings

### Task 10: Remove Min-Length Gate

**Objective**: Remove the 500-character minimum content length gate so all content is processed by the unified pipeline regardless of length.

**Where is the gate**:
- `classification.py:179` — `if len(content_text) < self.settings.classification_min_content_length:` (legacy, removed with classification.py in Task 11)
- `entity_extraction.py:181` — `if len(content_text) < 500:` (legacy, removed with entity_extraction.py in Task 11)
- `config.py:83` — `classification_min_content_length: int = 500` (legacy config key, removed in Task 11)
- `content.py:232-233` — `min_len` check before launching classification background task (WS4 removes this)
- `youtube.py:195-196` — `min_len` check before launching classification background task (WS4 removes this)

**What to do in unified pipeline**: The unified pipeline (`unified_pipeline.py`) does NOT have a min-length gate currently. It only checks `unified_pipeline_enabled` (line 326). After WS4 cutover, the routers will call the unified pipeline directly, so the old min-length gates in routers become dead code.

**Net action for WS5**: Verify that no min-length gate exists in the unified pipeline path. If WS4 introduces one, remove it. Remove the `classification_min_content_length` config key as part of Task 11 cleanup.

**Acceptance Criteria**:
- [ ] No min-length content gate exists in the unified pipeline execution path
- [ ] `classification_min_content_length` config key removed
- [ ] Short content (< 500 chars) is processed successfully by unified pipeline
- [ ] Test added: verify short content is not skipped
- [ ] `ruff check` passes, zero warnings

### Task 11: Delete Dead Legacy Code

**Objective**: Remove all dead code from the dual-task era, guided by the Legacy Code Inventory above.

**Execution order** (dependencies between deletions):

1. **Migrate shared utilities** from legacy files into `unified_pipeline.py` or a new `utils.py`:
   - `VALID_TIERS`, `LABEL_PATTERN`, `_dedup_label` from `classification.py`
   - `_confidence_to_float`, `_edge_type_from_string`, `_entity_type_from_string`, `_parse_topic_hierarchy` from `entity_extraction.py`
   - Update imports in `unified_pipeline.py` to point to new locations

2. **Delete legacy service files**:
   - `api/menos/services/classification.py` (entire file)
   - `api/menos/services/entity_extraction.py` (entire file)
   - Audit `entity_resolution.py` — if still used by unified pipeline, keep; if not, remove

3. **Verify classification router already deleted** (WS4 Task 7 deletes it):
   - Confirm `api/menos/routers/classification.py` no longer exists
   - Confirm `main.py` no longer registers classification router

4. **Clean storage.py**:
   - Remove `update_content_classification_status()` (lines 984-1003)
   - Remove `update_content_classification()` (lines 1005-1036)
   - Remove `update_content_extraction_status()` (lines 882-902)
   - Remove `get_interest_profile()` (lines 1038-1105)

5. **Clean models.py**:
   - Remove `ClassificationResult` (lines 183-193)
   - Remove `ExtractionResult` (lines 164-169)
   - Remove `ExtractionMetrics` (lines 172-180)

6. **Clean config.py**:
   - Remove: `classification_enabled`, `classification_provider`, `classification_model`, `classification_interest_top_n`, `classification_min_content_length`
   - Remove: `entity_extraction_enabled`, `entity_extraction_provider`, `entity_extraction_model`

7. **Clean di.py**:
   - Remove: `get_classification_provider()`, `get_classification_service()`, `get_entity_extraction_provider()`, `get_entity_resolution_service()` (if entity_resolution is removed)

8. **Verify `labels` terminology is gone from runtime**:
   - Decision 3: `tags` is canonical. After removing `classification.py`, search for any remaining `labels` references in runtime code (not test mocks)
   - `classification_max_new_labels` config key — rename or verify unified pipeline uses it correctly (it does: `unified_pipeline.py:155` reads `settings.classification_max_new_labels`). If classification config is removed, this needs to be renamed to `unified_pipeline_max_new_tags` or similar.

9. **Clean up tests**:
   - Remove or update `tests/unit/test_classification.py` (tests for deleted service)
   - Update any test imports that reference deleted modules
   - Verify all remaining tests pass

10. **Clean up scripts** (if not already done by WS4):
    - Verify `classify_content.py`, `reprocess_content.py`, `export_summaries.py` no longer reference legacy code

**Acceptance Criteria**:
- [ ] No `classification_status`, `entity_extraction_status` references in runtime code
- [ ] No `labels` terminology in runtime code (only `tags`)
- [ ] `classification.py` service file deleted
- [ ] `entity_extraction.py` service file deleted (or confirmed still needed)
- [ ] `classification.py` router file deleted
- [ ] Legacy storage methods removed
- [ ] Legacy models removed
- [ ] Legacy config keys removed
- [ ] Legacy DI wiring removed
- [ ] Shared utilities migrated to survive deletion
- [ ] `classification_max_new_labels` renamed to tag-based naming
- [ ] All tests pass, zero warnings
- [ ] `ruff check` and `ruff format` clean

---

## Execution Waves

### Wave 1: Observability + Retention (parallel)

| Task | Description | Parallel? |
|------|-------------|-----------|
| 8e | Observability baseline (correlation IDs, metrics, audit) | Yes |
| 8f | Retention/purge controls | Yes |

**Validation gate**: `uv run ruff check menos/ && uv run pytest tests/unit/ -v`

### Wave 2: Graph + Min-Length (parallel, after Wave 1)

| Task | Description | Parallel? |
|------|-------------|-----------|
| 9 | Graph endpoint alignment | Yes |
| 10 | Remove min-length gate | Yes |

**Validation gate**: `uv run ruff check menos/ && uv run pytest tests/ -v`

### Wave 3: Legacy Code Removal (sequential, after Wave 2)

| Task | Description | Parallel? |
|------|-------------|-----------|
| 11 | Delete dead legacy code | No (single sequential task) |

**Validation gate**: `uv run ruff check menos/ && uv run ruff format --check menos/ && uv run pytest tests/ -v`

---

## Team Members

| Role | Agent | Tasks |
|------|-------|-------|
| Builder A | ws5-builder-1 | Task 8e (observability), Task 9 (graph) |
| Builder B | ws5-builder-2 | Task 8f (retention), Task 10 (min-length) |
| Builder C | ws5-builder-3 | Task 11 (legacy cleanup — must run after all others) |
| Validator | ws5-validator | Final validation pass |

---

## Complexity Analysis

| Task | Complexity | Risk | Notes |
|------|-----------|------|-------|
| 8e — Observability | Medium | Low | Adding structured fields to existing log calls. Audit events are new log entries at router level. |
| 8f — Retention | Low | Low | Two DELETE queries + startup hook. Idempotent by nature. |
| 9 — Graph alignment | Low | Low | Graph queries don't reference legacy status fields. Mostly verification. |
| 10 — Min-length gate | Low | Low | Unified pipeline has no gate. Verify and add test. |
| 11 — Legacy cleanup | High | Medium | Many files touched. Risk of missing an import or breaking a test. Must be methodical. |

---

## Files to Create

| File | Purpose |
|------|---------|
| `api/tests/unit/test_retention.py` | Tests for purge mechanism |
| `api/tests/unit/test_observability.py` | Tests for correlation ID propagation and error taxonomy |

## Files to Modify

| File | Tasks | Changes |
|------|-------|---------|
| `api/menos/services/unified_pipeline.py` | 8e, 10, 11 | Add correlation IDs, stage timing, migrate shared utilities |
| `api/menos/services/jobs.py` | 8f | Add `purge_expired_jobs()` method |
| `api/menos/main.py` | 8f | Add purge call to lifespan handler |
| `api/menos/routers/graph.py` | 9 | Optional: add `processing_status` to `GraphNode` |
| `api/menos/services/storage.py` | 11 | Remove 4 legacy methods |
| `api/menos/models.py` | 11 | Remove 3 legacy models |
| `api/menos/config.py` | 11 | Remove legacy config keys, rename `classification_max_new_labels` |
| `api/menos/services/di.py` | 11 | Remove legacy DI functions |
| `api/tests/unit/test_unified_pipeline.py` | 8e, 10 | Add observability and short-content tests |
| `api/tests/unit/test_jobs.py` | 8f | Add purge tests |

## Files to Delete

| File | Task | Reason |
|------|------|--------|
| `api/menos/services/classification.py` | 11 | Replaced by unified pipeline |
| `api/menos/services/entity_extraction.py` | 11 | Replaced by unified pipeline |
| `api/menos/routers/classification.py` | 11 | Replaced by unified reprocess endpoint |
| `api/tests/unit/test_classification.py` | 11 | Tests for deleted service |

---

## Dependency Graph

```
WS3 (job model) ──┐
                   ├──> Task 8e (observability) ──┐
WS4 (routers)  ───┤                               │
                   ├──> Task 8f (retention)  ──────┤
                   │                               ├──> Task 11 (legacy cleanup)
                   ├──> Task 9  (graph)      ──────┤
                   │                               │
                   └──> Task 10 (min-length) ──────┘

Task 11 ──> WS6 (validation)
```

---

## Final Step: Commit

After validation passes, create a commit with all WS5 changes:
- Determine semver bump level (likely `minor` — new observability features + cleanup, no breaking API contract changes)
- Run `make version-bump-minor` from repo root
- Stage all changed files (excluding unrelated/untracked files)
- Commit message format: `feat: add pipeline observability, retention controls, and remove legacy code`
- Include bump level and rationale in commit body
