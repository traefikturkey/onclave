---
created: 2026-02-11
completed: 2026-02-11
status: completed
blocked_by: ws1, ws2
parent: plan.md
---

# Team Plan: WS3 — Schema + Job Model

## Objective

Replace the dual `classification_status`/`entity_extraction_status` fields with a unified
`processing_status` + `processed_at` model. Create the `pipeline_job` table for job-first
authority with full lifecycle states.

## Depends On
- WS1 (unified pipeline must exist)
- WS2 (config + DI for pipeline_version)

## Tasks from Master Plan

### Task 6: Content status hard replacement
- Migration: add `processing_status`, `processed_at`, `pipeline_version` to content
- Migration: remove `classification_status`, `classification_at`, `entity_extraction_status`, `entity_extraction_at`
- Update `storage.py` repository methods for new status fields
- Update `models.py` ContentMetadata if needed

### Task 6a: Persistent job model
- Migration: create `pipeline_job` table
- Job lifecycle states: `pending`, `processing`, `completed`, `failed`, `cancelled`
- Idempotency key storage and lookup
- Canonical resource key generation:
  - YouTube: `yt:<video_id>`
  - URL: `url:<hash16>` (16-char base64url of SHA-256)
  - Fallback: `cid:<content_id>`
- URL normalization (lowercase host, strip fragment, remove tracking params, deterministic sort)
- Compact/full data tier model
- Timestamp contract: `created_at`, `started_at`, `finished_at`
- Job `pipeline_version`

## Files to Create
- `api/migrations/YYYYMMDD-HHMMSS_unified_status.surql`
- `api/migrations/YYYYMMDD-HHMMSS_pipeline_job.surql`
- `api/menos/services/jobs.py` (or extend storage.py)
- `api/menos/services/resource_key.py` (canonical key + URL normalization)

## Files to Modify
- `api/menos/models.py`
- `api/menos/services/storage.py`
- `api/tests/unit/` (new tests for jobs, resource keys, URL normalization)

## Acceptance Criteria
- [ ] Migrations are idempotent and safe for hard-cutover replacement
- [ ] `processing_status` replaces dual status fields in all code paths
- [ ] `pipeline_job` table with full lifecycle
- [ ] Idempotency keys prevent duplicate jobs
- [ ] URL normalization is deterministic
- [ ] All existing tests updated and passing

## Final Step: Commit

After validation passes, create a commit with all WS3 changes:
- Determine semver bump level (likely `minor` — new schema tables + status model)
- Run `make version-bump-minor` from repo root
- Stage all changed files (excluding unrelated/untracked files)
- Commit message format: `feat: add unified processing status, pipeline_job table, and resource keys`
- Include bump level and rationale in commit body
