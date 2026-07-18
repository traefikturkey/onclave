---
created: 2026-02-11
completed:
status: blocked
blocked_by: ws1, ws2, ws3, ws4, ws5
parent: plan.md
---

# Team Plan: WS6 — Validation + Release Readiness

## Objective

Full end-to-end verification that the unified pipeline is the only ingest path, all contracts
are honored, documentation is accurate, and the codebase is release-ready. This is primarily
a verification and documentation workstream with no new runtime features.

## Depends On
- WS1 (parsing + orchestration)
- WS2 (config + DI + semver)
- WS3 (schema + job model)
- WS4 (router cutover + job APIs + callbacks)
- WS5 (observability + retention + legacy cleanup)

## Project Context

- **Language**: Python 3.12+
- **Framework**: FastAPI, Pydantic, SurrealDB
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Format command**: `cd api && uv run ruff format menos/`
- **Smoke command**: `cd api && uv run pytest tests/smoke/ -m smoke -v`

## Current Codebase (Built by WS1-WS5)

### WS1 — Parsing + Orchestration
- `api/menos/services/unified_pipeline.py` — `UnifiedPipelineService`, `parse_unified_response()`
- `api/menos/services/llm_json.py` — `extract_json()` shared JSON extraction utility
- `api/tests/unit/test_unified_parser.py` — parser contract tests
- `api/tests/unit/test_unified_pipeline.py` — orchestration tests

### WS2 — Config + DI + Semver
- `api/menos/config.py` — `unified_pipeline_enabled`, `unified_pipeline_provider`, `unified_pipeline_model`, `unified_pipeline_max_concurrency`, `app_version` property
- `api/menos/services/di.py` — `get_unified_pipeline_provider()`, `get_unified_pipeline_service()`
- `api/menos/routers/health.py` — `/health` returns `app_version`

### WS3 — Schema + Job Model
- `api/menos/models.py` — `UnifiedResult`, `PipelineJob`, `JobStatus`, `DataTier`
- `api/menos/services/jobs.py` — `JobRepository` with full CRUD
- `api/menos/services/resource_key.py` — `normalize_url()`, `generate_resource_key()`
- `api/menos/services/storage.py` — `update_content_processing_status()`, `update_content_processing_result()`
- `api/migrations/20260211-120000_unified_status.surql` — processing_status fields
- `api/migrations/20260211-120100_pipeline_job.surql` — pipeline_job table
- `api/tests/unit/test_jobs.py`, `api/tests/unit/test_resource_key.py`

### WS4 — Router/API Cutover (expected)
- `api/menos/routers/youtube.py` — cut over to unified pipeline, returns job_id
- `api/menos/routers/content.py` — cut over to unified pipeline, returns job_id
- `api/menos/routers/jobs.py` — job status, reprocess, cancel endpoints
- `api/menos/services/callbacks.py` — callback notifications with HMAC-SHA256
- Scripts updated to use `processing_status`

### WS5 — Observability + Cleanup (expected)
- Structured logging with correlation IDs across pipeline stages
- Job metrics (duration, stage latency)
- Audit events for key actions
- Retention purge for pipeline_job (compact: 6mo, full: 2mo)
- `api/menos/routers/graph.py` — aligned with unified data model
- Min-length gate removed
- Dead legacy code removed (old classification/extraction status methods, old models)

## Team Members

| Name | Agent | Role |
|------|-------|------|
| ws6-builder | builder (sonnet) | Run verifications, write documentation |
| ws6-validator | validator (haiku) | Cross-check verification results, final sign-off |

## Tasks

### Task 12a: Automated lint/format/test verification

- **Owner**: ws6-builder
- **Blocked By**: none (all WS1-WS5 must be complete before WS6 starts)
- **Description**: Run the full automated verification suite and confirm zero warnings, zero failures.

  Run these commands in order:
  ```bash
  cd api && uv run ruff check menos/
  cd api && uv run ruff format --check menos/
  cd api && uv run pytest tests/unit/ -v
  cd api && uv run pytest tests/integration/ -v
  ```

- **Acceptance Criteria**:
  - [ ] `ruff check` passes with zero warnings
  - [ ] `ruff format --check` passes (all files formatted)
  - [ ] All unit tests pass
  - [ ] All integration tests pass
  - [ ] No debug statements (`print()`, `breakpoint()`, `pdb`) in production code

### Task 12b: Grep-based terminology verification

- **Owner**: ws6-builder
- **Blocked By**: Task 12a
- **Description**: Verify that all legacy terminology has been removed from runtime code. Use grep to confirm no stale references remain.

  **Must return zero matches in `api/menos/`:**
  ```bash
  # Legacy dual-task status fields — must be completely gone from runtime
  grep -r "classification_status" api/menos/
  grep -r "entity_extraction_status" api/menos/
  grep -r "classification_at" api/menos/
  grep -r "entity_extraction_at" api/menos/

  # Legacy "labels" terminology in runtime code (tests may reference for comparison)
  grep -r '"labels"' api/menos/

  # Old dual-task background task patterns
  grep -r "background_tasks\.add_task.*classify" api/menos/routers/
  grep -r "background_tasks\.add_task.*extract" api/menos/routers/

  # Dead imports from removed modules
  grep -r "from menos.services.classification import" api/menos/routers/
  grep -r "from menos.services.entity_extraction import" api/menos/routers/
  ```

  **Must return matches (positive verification):**
  ```bash
  # processing_status is the active model
  grep -r "processing_status" api/menos/services/storage.py
  grep -r "processing_status" api/menos/models.py

  # tags terminology is canonical
  grep -r '"tags"' api/menos/services/unified_pipeline.py

  # pipeline_version is persisted
  grep -r "pipeline_version" api/menos/services/jobs.py
  grep -r "pipeline_version" api/menos/models.py

  # app_version is exposed
  grep -r "app_version" api/menos/routers/health.py
  grep -r "app_version" api/menos/config.py
  ```

- **Acceptance Criteria**:
  - [ ] All "must return zero" greps return no matches
  - [ ] All "must return matches" greps return at least one match
  - [ ] No `labels` references remain in runtime code (`api/menos/`)
  - [ ] `processing_status` is the only status model in active code

### Task 12c: Smoke tests against live deployment

- **Owner**: ws6-builder
- **Blocked By**: Task 12a (deployment must be done before smoke tests)
- **Description**: Deploy the final build and run smoke tests against the live server.

  **Pre-requisite**: Deploy using Ansible pipeline:
  ```bash
  cd infra/ansible && docker compose run --rm ansible ansible-playbook -i inventory/hosts.yml playbooks/deploy.yml
  ```

  **Smoke test execution:**
  ```bash
  cd api && uv run pytest tests/smoke/ -m smoke -v
  ```

  **Manual endpoint verification** (using signed requests):
  ```bash
  cd api
  # Health check with app_version
  PYTHONPATH=. uv run python scripts/signed_request.py GET /health

  # Ingest a test video (should return job_id)
  PYTHONPATH=. uv run python scripts/signed_request.py POST /api/v1/youtube/ingest '{"url":"https://www.youtube.com/watch?v=TEST_ID"}'

  # Check job status
  PYTHONPATH=. uv run python scripts/signed_request.py GET /api/v1/jobs/{job_id}

  # Verify content has processing_status
  PYTHONPATH=. uv run python scripts/signed_request.py GET /api/v1/content

  # Graph endpoint returns unified data model
  PYTHONPATH=. uv run python scripts/signed_request.py GET /api/v1/graph?limit=10
  ```

- **Acceptance Criteria**:
  - [ ] Deployment succeeds (post-deploy `/health` SHA matches)
  - [ ] All smoke tests pass
  - [ ] `/health` returns `app_version` field with valid semver
  - [ ] Ingest returns `job_id` (async job-based)
  - [ ] Job status endpoint works (minimal + verbose)
  - [ ] Content records show `processing_status` field
  - [ ] Graph endpoint returns unified data model
  - [ ] No 500 errors in `docker logs menos-api`

### Task 12d: Documentation — create unified pipeline spec

- **Owner**: ws6-builder
- **Blocked By**: Task 12b
- **Description**: Create `docs/specs/unified-pipeline.md` as the canonical specification for the unified pipeline.

  Content should cover:
  - Pipeline overview (single LLM call for classification + entity extraction)
  - Input/output contract (`UnifiedResult` fields)
  - Job lifecycle (`PipelineJob` states: pending, processing, completed, failed, cancelled)
  - Resource key format (yt, url, cid prefixes)
  - API endpoints (ingest, job status, job cancel, reprocess)
  - Configuration settings (provider, model, max_concurrency)
  - Callback contract (HMAC-SHA256, retry policy, schema_version)
  - Observability (correlation IDs, metrics, audit events)
  - Data tiers (compact vs full, retention policy)

  Reference actual code locations:
  - `api/menos/services/unified_pipeline.py` — pipeline service
  - `api/menos/services/jobs.py` — job repository
  - `api/menos/services/resource_key.py` — resource key generation
  - `api/menos/services/callbacks.py` — callback delivery
  - `api/menos/models.py` — data models
  - `api/menos/config.py` — configuration

- **Acceptance Criteria**:
  - [ ] `docs/specs/unified-pipeline.md` exists
  - [ ] Covers all sections listed above
  - [ ] All file references point to real files
  - [ ] Uses `tags` terminology (not `labels`)
  - [ ] Uses `processing_status` terminology (not legacy fields)

### Task 12e: Documentation — update existing docs

- **Owner**: ws6-builder
- **Blocked By**: Task 12d
- **Description**: Update existing documentation to reflect the unified pipeline.

  **Files to update:**

  1. `docs/ingest-pipeline.md` — Rewrite to describe the unified pipeline:
     - Remove references to dual classification + entity extraction tasks
     - Document single LLM call flow
     - Document job-based async processing
     - Reference `processing_status` lifecycle

  2. `docs/schema.md` — Add/update:
     - `processing_status`, `processed_at`, `pipeline_version` on content
     - `pipeline_job` table schema
     - Remove references to `classification_status`, `entity_extraction_status`

  3. `.claude/rules/architecture.md` — Update:
     - Directory structure (add `jobs.py`, `resource_key.py`, `callbacks.py`, `llm_json.py`)
     - Service descriptions (unified pipeline, job repository)
     - Design patterns (job-first authority model)
     - Remove references to dual-task architecture

  4. `.claude/rules/schema.md` — Update:
     - Content table fields (processing_status replaces dual status)
     - Add pipeline_job table
     - Add resource key patterns

- **Acceptance Criteria**:
  - [ ] `docs/ingest-pipeline.md` describes unified pipeline only
  - [ ] `docs/schema.md` includes `processing_status` and `pipeline_job`
  - [ ] `.claude/rules/architecture.md` reflects current directory structure
  - [ ] `.claude/rules/schema.md` reflects current schema
  - [ ] No references to `classification_status` or `entity_extraction_status` in any updated doc
  - [ ] No references to `labels` in any updated doc

### Task 12f: Cross-reference against Definition of Done

- **Owner**: ws6-validator
- **Blocked By**: Task 12a, Task 12b, Task 12c, Task 12e
- **Description**: Final validation that every item in the master plan Definition of Done is satisfied. Walk through each item and verify with evidence.

  | DoD Item | Verification Method |
  |----------|-------------------|
  | Unified pipeline is the only ingest path | Grep: no dual-task `background_tasks.add_task` in routers |
  | `processing_status` is the only active model | Grep: no `classification_status`/`entity_extraction_status` in `api/menos/` |
  | `tags` naming is canonical | Grep: no `"labels"` in runtime code |
  | Old dual-task code path removed | Grep: no legacy imports in routers |
  | Job APIs work | Smoke test: POST ingest, GET job status, POST cancel |
  | Callback + observability operational | Smoke test: verify correlation IDs in logs, callback delivery |
  | Semver + `app_version` in place | `GET /health` returns valid semver in `app_version` |
  | Lint/format/tests zero warnings | Task 12a results |

- **Acceptance Criteria**:
  - [ ] Every DoD item has documented evidence of satisfaction
  - [ ] No items are skipped or deferred
  - [ ] All verification methods executed successfully

## Execution Waves

### Wave 1: Automated Verification (Task 12a, 12b)
Run lint, format, tests, and grep-based checks. These are fully automated and can run in parallel.

**Gate**: All automated checks pass with zero warnings/failures before proceeding.

### Wave 2: Live Verification (Task 12c)
Deploy and run smoke tests against the live server.

**Gate**: Deployment succeeds, all smoke tests pass, manual endpoint verification confirms expected behavior.

### Wave 3: Documentation (Task 12d, 12e)
Create unified pipeline spec and update all existing documentation. These can run in parallel.

**Gate**: All documentation files exist and accurately reflect the current codebase.

### Wave 4: Final Sign-off (Task 12f)
Cross-reference every Definition of Done item with evidence from Waves 1-3.

**Gate**: Every DoD item verified. WS6 is complete.

## Complexity Analysis

| Task | Complexity | Rationale |
|------|-----------|-----------|
| 12a — Lint/format/tests | Low | Standard commands, pass/fail |
| 12b — Grep verification | Low | Mechanical grep checks, well-defined patterns |
| 12c — Smoke tests | Medium | Requires deployment, live server interaction, manual verification |
| 12d — Create spec doc | Medium | Requires synthesizing information from multiple sources |
| 12e — Update existing docs | Medium | Multiple files, must accurately reflect post-cutover state |
| 12f — DoD cross-reference | Low | Checklist verification against evidence from prior tasks |

## Dependency Graph

```
Task 12a (lint/format/tests) ──┬──> Task 12b (grep verification)
                                │
                                └──> Task 12c (smoke tests)
                                              │
Task 12b ──> Task 12d (create spec) ──> Task 12e (update docs)
                                                       │
Tasks 12a + 12b + 12c + 12e ──────────> Task 12f (DoD sign-off)
```

## Files to Create

| File | Task | Purpose |
|------|------|---------|
| `docs/specs/unified-pipeline.md` | 12d | Canonical unified pipeline specification |

## Files to Modify

| File | Task | Changes |
|------|------|---------|
| `docs/ingest-pipeline.md` | 12e | Rewrite for unified pipeline (remove dual-task references) |
| `docs/schema.md` | 12e | Add processing_status, pipeline_job; remove legacy status fields |
| `.claude/rules/architecture.md` | 12e | Update directory structure, service descriptions, design patterns |
| `.claude/rules/schema.md` | 12e | Update content table fields, add pipeline_job table |

## Definition of Done (from master plan)

- [ ] Unified pipeline is the only ingest processing path
- [ ] `processing_status` is the only active content processing model
- [ ] `tags` naming is canonical across runtime + docs
- [ ] Old dual-task code path is removed
- [ ] Job APIs (trigger/status/cancel) work with defined contracts
- [ ] Callback + observability + retention controls are operational
- [ ] Semver policy and runtime `app_version` are in place
- [ ] Lint/format/tests pass with zero warnings

## Final Step: Commit

After all verification passes and docs are updated, create a commit:
- Determine semver bump level (`patch` — docs/specs only, no runtime changes)
- Run `make version-bump-patch` from repo root
- Stage all changed files (excluding unrelated/untracked files)
- Commit message format: `docs: update specs, schema docs, and architecture rules for unified pipeline`
- Include bump level and rationale in commit body
