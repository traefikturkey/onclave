---
created: 2026-02-11
completed: 2026-02-11
status: completed
blocked_by:
parent: plan.md
---

# Team Plan: WS2 — Config + Semver Governance

## Objective

Add unified pipeline configuration to settings, wire up DI, surface app semver to runtime,
and codify the versioning policy in CI/workflow checks.

## Depends On
- WS1 (unified pipeline service must exist before wiring config + DI)

## Tasks from Master Plan

### Task 5: Config + DI cutover
- Add `unified_pipeline_provider`, `unified_pipeline_model`, `UNIFIED_PIPELINE_MAX_CONCURRENCY` to config
- Create `get_unified_pipeline_provider()` and `get_unified_pipeline_service()` in `di.py`
- Surface semver from `pyproject.toml` to runtime
- Add `app_version` to `/health` endpoint response

### Task 5a: Semver governance
- Enforce semver format and source-of-truth consistency
- Codify bump-level policy and practical split in workflow docs/checks
- Makefile commands already exist (`make version-bump-*`), verify they work with new policy

## Files to Modify
- `api/menos/config.py`
- `api/menos/services/di.py`
- `api/menos/routers/health.py`
- `api/pyproject.toml` (version bump)

## Acceptance Criteria
- [ ] Config fields added with sensible defaults
- [ ] DI wiring for unified pipeline service works
- [ ] `/health` returns `app_version` field
- [ ] `make version-check` passes
- [ ] All existing tests pass

## Final Step: Commit

After validation passes, create a commit with all WS2 changes:
- Determine semver bump level (likely `minor` — new config fields + DI wiring)
- Run `make version-bump-minor` from repo root
- Stage all changed files (excluding unrelated/untracked files)
- Commit message format: `feat: add unified pipeline config, DI wiring, and app_version endpoint`
- Include bump level and rationale in commit body
