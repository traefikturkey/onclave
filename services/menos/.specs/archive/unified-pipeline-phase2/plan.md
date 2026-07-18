---
created: 2026-02-11
completed:
status: ready-for-implementation
approach: hard-cutover
---

# Team Plan: Unified Pipeline Phase 2 (Hard Cutover)

## Objective
Replace the dual-task ingest architecture with one unified pipeline that is clean, traceable, and easy to refine.

Core outcomes:
- single ingest execution path
- single taxonomy term (`tags`)
- single processing status model
- async job orchestration with strong observability

## Out of Scope
- preserving legacy dual-task compatibility
- preserving legacy status fields
- bulk fleet reprocessing strategy (separate plan)

## Locked Architecture Decisions

### A) Core pipeline
1. Hard cutover: remove legacy dual-task path in this phase.
2. Unified result persistence is strict all-or-nothing.
3. `tags` is canonical taxonomy everywhere (replace `labels` terminology).
4. No rollout feature flag for pipeline path.

### B) Status and authority model
5. Replace `classification_status` + `entity_extraction_status` with `processing_status` + `processed_at`.
6. Job-first authority model:
   - `pipeline_job.status` is authoritative per run
   - `content.processing_status` is latest content-level projection
7. `content.processing_status` mirrors full lifecycle: `pending`, `processing`, `completed`, `failed`, `cancelled`.
8. `processed_at` updates on every state transition ("last status touch").
9. Timestamp contract:
   - `pipeline_job.created_at`
   - `pipeline_job.started_at`
   - `pipeline_job.finished_at`
   - `content.processed_at`

### C) API and graph contracts
10. Graph API is hard cutover on existing endpoint: replace `/api/v1/graph` contract directly.
11. Ingest and reprocess are async job-based and return `job_id` immediately.
12. Job status endpoint supports tiers:
   - default minimal
   - `verbose=true` diagnostics

### D) Reprocessing behavior
13. Reprocess scope in this phase is one item at a time.
14. Single-item reprocess must be available via both CLI and API.
15. Reprocess uses stored transcript/content + metadata first.
16. External metadata is fetched only when required fields are missing.
17. If an active job exists for the same resource, return existing active `job_id` only.
18. Once job is terminal, explicit re-trigger creates a new job.

### E) Job orchestration and reliability
19. Job storage is hybrid with DB as source of truth; in-memory cache is optional and non-authoritative.
20. Pipeline retries are manual-only (no auto retry for ingest/reprocess jobs).
21. Global bounded concurrency is required via `UNIFIED_PIPELINE_MAX_CONCURRENCY`.
22. Job cancellation is best-effort:
   - `pending`: immediate cancel
   - `processing`: cancel only between pipeline stages
23. Cancellation terminal state is `cancelled`.

### F) Idempotency and identity
24. Idempotency is system-derived (user does not provide key).
25. Canonical resource key format:
   - YouTube: `yt:<video_id>`
   - URL: `url:<hash16>` where `hash16` is 16-char base64url of SHA-256(normalized_url)
   - fallback: `cid:<content_id>`
26. URL normalization policy is aggressive baseline:
   - lowercase host, strip fragment, normalize path, remove default ports
   - remove tracking params (e.g. `utm_*`, `fbclid`, `gclid`)
   - deterministic sort of retained params
   - preserve identity-bearing params

### G) Callbacks, observability, audit
27. Optional callbacks are supported with HMAC-SHA256 signatures.
28. Callback retry policy is fixed: 3 attempts with exponential backoff.
29. Callback retries reuse stable `callback_event_id` (idempotent receiver model).
30. Callback payload includes `schema_version`.
31. Callback delivery state is independent from pipeline outcome.
32. Observability baseline is required: structured logs, correlation IDs, job/stage metrics.
33. Audit scope is balanced:
   - full-tier access
   - reprocess triggers
   - cancellation request/outcome
   - callback delivery attempts/final state
34. Job error contract uses fixed taxonomy fields:
   - `error_code`, `error_message`, `error_stage`

### H) Data retention and access
35. Two-tier job observability storage:
   - compact diagnostics tier
   - full payload/prompt tier
36. Retention policy:
   - compact tier: 6 months
   - full tier: 2 months
   - scheduled purge required and idempotent
37. Full-tier data access is owner-only (auditable).
38. Reprocess/cancel authorization is owner-scoped with admin override when admin role exists.

### I) Versioning policy
39. Persist `pipeline_version` on each `pipeline_job` and latest on `content`.
40. `pipeline_version` source is app semver from `api/pyproject.toml` / release tag.
41. `pipeline_version` stores full semver string (e.g. `2.1.0`).
42. Semver bump policy:
   - `major`: breaking contracts/behavior
   - `minor`: backward-compatible features
   - `patch`: backward-compatible fixes/refactors/docs/tests
43. Semver bump timing: per code commit.
44. Practical split:
   - bump required for code/config/schema/API behavior changes
   - bump optional for docs-only/test-only commits
45. `.specs/` and `.claude/` changes follow docs-only semantics (optional bump unless runtime changes in same commit).
46. Migration bump classification is impact-based:
   - breaking/destructive: `major`
   - additive/backward-compatible: `minor` or `patch`
47. Runtime semver exposed in health/version endpoint as `app_version`.

## Implementation Workstreams

### Workstream 1: Parsing + orchestration (TDD first)
- `Task 1` TDD: unified parser contract (`api/tests/unit/test_unified_parser.py`)
- `Task 2` Shared LLM JSON utility (`api/menos/services/llm_json.py`)
- `Task 3` TDD: unified orchestration (`api/tests/unit/test_unified_pipeline.py`)
- `Task 4` Implement unified pipeline service (`api/menos/services/unified_pipeline.py`)

Acceptance highlights:
- parser rejects malformed unified payloads
- strict all-or-nothing persistence path is covered by tests
- no duplicate legacy parser logic remains

### Workstream 2: Config + semver governance
- `Task 5` Config + DI cutover
  - `unified_pipeline_provider`, `unified_pipeline_model`, `UNIFIED_PIPELINE_MAX_CONCURRENCY`
  - semver surfaced to runtime
  - health/version includes `app_version`
- `Task 5a` Semver governance
  - enforce semver format and source-of-truth consistency
  - codify bump-level policy and practical split in workflow docs/checks

### Workstream 3: Schema + job model
- `Task 6` Content status hard replacement
  - new status fields and update semantics
  - remove legacy status usage
  - persist content `pipeline_version`
- `Task 6a` Persistent job model
  - `pipeline_job` lifecycle states: `pending`, `processing`, `completed`, `failed`, `cancelled`
  - idempotency key storage
  - canonical resource key generation + URL normalization
  - compact/full data tier model
  - timestamp contract
  - job `pipeline_version`

### Workstream 4: Router/API cutover
- `Task 7` Hard cutover ingest routers (`youtube.py`, `content.py`)
- `Task 8` Rewrite scripts to unified status model (`classify_content.py`, `reprocess_content.py`, `export_summaries.py`)
- `Task 8a` Reprocess API endpoint (single-item, async, owner-scoped)
- `Task 8c` Job status endpoint (minimal + verbose)
- `Task 8g` Job cancellation endpoint (best-effort, stage-boundary only)
- `Task 8d` Callback notifications (signed, retries, event id, schema version)

### Workstream 5: Observability + retention + cleanup
- `Task 8e` Observability baseline
  - structured logs, correlation IDs, core metrics, audit events, taxonomy consistency
- `Task 8f` Retention/purge controls
  - 6-month compact tier, 2-month full tier, idempotent purge
- `Task 9` Graph endpoint hard contract alignment (`/api/v1/graph`)
- `Task 10` Remove min-length gate
- `Task 11` Delete dead legacy code

### Workstream 6: Validation + release readiness
- `Task 12` Full verification
  - lint/format/tests all passing
  - real-content ingest smoke
  - callback/job/observability validation
  - zero warnings

## Dependency Flow (Execution Order)
```
Task 1 -> Task 2
Task 1 -> Task 3 -> Task 4

Task 4 -> Task 5
Task 5 -> Task 5a

Task 4 + Task 5 -> Task 6
Task 5 -> Task 6a

Task 4 + Task 6 -> Task 7
Task 6 + Task 6a -> Task 8

Task 7 -> Task 8a
Task 6a + Task 7 + Task 8a -> Task 8c
Task 6a + Task 7 + Task 8c -> Task 8g
Task 6a + Task 7 + Task 8a -> Task 8d
Task 6a + Task 7 -> Task 8e
Task 6a -> Task 8f

Task 4 + Task 7 -> Task 9
Task 7 -> Task 10

Tasks 6, 6a, 7, 8, 8a, 8c, 8d, 8e, 8f, 8g, 9, 10 -> Task 11
Tasks 1-11 -> Task 12
```

## Files to Create
- `api/menos/services/unified_pipeline.py`
- `api/menos/services/llm_json.py`
- `api/tests/unit/test_unified_parser.py`
- `api/tests/unit/test_unified_pipeline.py`
- `api/tests/integration/test_unified_pipeline_wiring.py`
- `docs/specs/unified-pipeline.md`

## Files to Modify
- `api/pyproject.toml`
- `api/menos/config.py`
- `api/menos/services/di.py`
- `api/menos/services/classification.py`
- `api/menos/services/entity_extraction.py`
- `api/menos/services/entity_resolution.py` (composition-focused changes only)
- `api/menos/services/storage.py`
- `api/menos/services/jobs.py` (if present)
- `api/menos/routers/youtube.py`
- `api/menos/routers/content.py`
- `api/menos/routers/jobs.py` (new or existing)
- `api/menos/routers/health.py` (or existing version endpoint router)
- `api/menos/routers/graph.py`
- `api/scripts/classify_content.py`
- `api/scripts/reprocess_content.py`
- `api/scripts/export_summaries.py`
- `api/tests/conftest.py`
- `docs/ingest-pipeline.md`
- `docs/schema.md`
- `.claude/rules/architecture.md`
- `.claude/rules/schema.md`

## Files to Delete (Legacy)
- legacy dual-task status helpers and call paths
- legacy parser compatibility aliases tied only to `labels`

## Definition of Done
- unified pipeline is the only ingest processing path
- `processing_status` is the only active content processing model
- `tags` naming is canonical across runtime + docs
- old dual-task code path is removed
- job APIs (trigger/status/cancel) work with defined contracts
- callback + observability + retention controls are operational
- semver policy and runtime `app_version` are in place
- lint/format/tests pass with zero warnings

## Spec Alignment
- Add: `docs/specs/unified-pipeline.md`
- Update: `docs/ingest-pipeline.md`, `docs/schema.md`, `.claude/rules/architecture.md`, `.claude/rules/schema.md`
- Keep historical specs unchanged (reference only)
