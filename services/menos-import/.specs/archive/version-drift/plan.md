---
created: 2026-02-11
completed:
---

# Team Plan: Version Drift Detection

## Objective
Detect content processed by old pipeline versions and report staleness. This enables human-driven decisions about reprocessing content after major or minor pipeline changes without automatic reprocessing.

The system tracks `pipeline_version` (from `app_version` in pyproject.toml, currently `0.4.2`) on each content record. Version drift detection compares content's `pipeline_version` against the current app version and identifies items processed by older major/minor versions (patch bumps like 0.4.1 -> 0.4.2 are NOT drift, but 0.4.x -> 0.5.0 IS drift). Missing/invalid/unknown pipeline versions are not drift and are reported separately.

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Version comparison utility | 1-2 | feature | sonnet | builder |
| T2: Storage drift query method | 1-2 | feature | sonnet | builder |
| T3: Drift endpoint in jobs router | 2 | feature | sonnet | builder |
| T4: Startup drift logging | 1 | feature | sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| drift-builder-1 | builder | sonnet | Version comparison + storage query |
| drift-builder-2 | builder | sonnet | API endpoint + startup logging |
| drift-validator-1 | validator-heavy | sonnet | Wave validation |

## Execution Waves

### Wave 1 (parallel)

**T1: Version comparison utility** [sonnet] — drift-builder-1

Create `api/menos/services/version_utils.py` with version comparison logic:

1. **Function: `has_version_drift(old_version: str | None, current_version: str | None) -> bool`**
   - Returns `True` if major or minor differs, `False` otherwise
   - Parse versions using simple split logic: `major.minor.patch`
   - Handle edge cases: `None`, `"unknown"`, malformed versions (return `False` for safety)
   - Example: `("0.4.2", "0.4.3")` → `False`, `("0.4.2", "0.5.0")` → `True`, `("0.4.2", "1.0.0")` → `True`

2. **Function: `parse_version_tuple(version: str | None) -> tuple[int, int, int] | None`**
   - Parse semver string to `(major, minor, patch)` tuple
   - Return `None` for invalid input

**Acceptance Criteria:**
- `has_version_drift()` correctly identifies major/minor changes as drift
- Patch-only changes return `False`
- Edge cases handled: `None`, `"unknown"`, malformed strings (all return `False` for drift)
- Function signatures explicitly allow nullable input (`str | None`)
- Unit tests cover valid semver, patch-only, major/minor drift, and nullable/invalid inputs

**Files to create:**
- `api/menos/services/version_utils.py`
- `api/tests/unit/test_version_utils.py`

---

**T2: Storage drift query method** [sonnet] — drift-builder-1

Add drift query method to `api/menos/services/storage.py` in `SurrealDBRepository`:

1. **Method: `async def get_version_drift_report(self, current_version: str) -> dict`**
   - Query SurrealDB: `SELECT pipeline_version, count() AS cnt FROM content WHERE processing_status = 'completed' GROUP BY pipeline_version`
   - Parse result, filter using `has_version_drift()` to keep only versions with major/minor drift
   - Count missing/invalid/unknown versions separately into `unknown_version_count` (not included in `stale_content`)
   - Return structure:
     ```python
     {
       "current_version": "0.5.0",
       "stale_content": [
         {"version": "0.4.2", "count": 150},
         {"version": "0.3.1", "count": 12}
       ],
       "total_stale": 162,
       "unknown_version_count": 7,
       "total_content": 500  # total completed content count
     }
     ```
   - Include query for total content count: `SELECT count() FROM content WHERE processing_status = 'completed' GROUP ALL`

**Acceptance Criteria:**
- Query groups content by `pipeline_version` correctly
- Only versions with major/minor drift are included in `stale_content`
- Missing/invalid/unknown versions are excluded from drift and counted in `unknown_version_count`
- Counts are accurate
- Total content count is included
- Unit tests mock SurrealDB query results and verify drift filtering and unknown bucket logic

**Files to modify:**
- `api/menos/services/storage.py` (add method to `SurrealDBRepository`)
- `api/tests/unit/test_storage.py` (add drift report tests)

---

### Wave 2 (sequential after Wave 1)

**T3: Drift endpoint in jobs router** [sonnet] — drift-builder-2, blockedBy: [T1, T2]

Add drift detection endpoint to `api/menos/routers/jobs.py`:

1. **Endpoint: `GET /api/v1/jobs/drift`**
   - Response model: `DriftReportResponse`
     ```python
      class VersionCount(BaseModel):
          version: str
          count: int

      class DriftReportResponse(BaseModel):
          current_version: str
          stale_content: list[VersionCount]
          total_stale: int
          unknown_version_count: int
          total_content: int
      ```
   - Call `surreal_repo.get_version_drift_report(settings.app_version)`
   - Return formatted response
   - Requires authentication (`AuthenticatedKeyId` dependency)

**Acceptance Criteria:**
- Endpoint returns drift report with correct structure
- Response includes current version, stale content grouped by version, `unknown_version_count`, and totals
- Endpoint requires authentication
- Unit tests cover: (a) report with drift, (b) report with no drift, (c) unknown/invalid versions bucketed separately, (d) empty database

**Files to modify:**
- `api/menos/routers/jobs.py` (add endpoint + response models)
- `api/tests/unit/test_jobs_router.py` (add tests, create if needed)

---

**T4: Startup drift logging** [sonnet] — drift-builder-2, blockedBy: [T1, T2]

Add drift logging to `api/menos/main.py` lifespan:

1. After migrations and purge, log drift count:
    - Create SurrealDB connection
    - Call `get_version_drift_report(settings.app_version)`
    - Log: `logger.info("version_drift: %d stale items (current=%s, unknown_versions=%d)", total_stale, current_version, unknown_version_count)`
    - If no drift, log: `logger.info("version_drift: no stale content (current=%s, unknown_versions=%d)", current_version, unknown_version_count)`
    - Handle errors gracefully (log warning, continue startup)

**Acceptance Criteria:**
- Startup log line reports drift count
- Log includes current version and `unknown_version_count`
- No drift case logged appropriately
- Errors during drift check don't prevent startup
- Log appears after migrations and purge logs

**Files to modify:**
- `api/menos/main.py` (add to `lifespan` function)

---

### Wave 2 Validation

- V1: Validate wave 2 [sonnet] — drift-validator-1, blockedBy: [T3, T4]
  - Run `cd api && uv run pytest tests/unit/ -v` — all tests pass
  - Run `cd api && uv run ruff check menos/` — no lint errors
  - Verify endpoint response model has proper type hints
  - Verify startup log format matches existing log patterns
  - Manually test endpoint with `uv run python scripts/signed_request.py GET /api/v1/jobs/drift`

## Dependency Graph

Wave 1: T1 (version utils), T2 (storage query) → Wave 2: T3 (endpoint), T4 (logging) → V1
