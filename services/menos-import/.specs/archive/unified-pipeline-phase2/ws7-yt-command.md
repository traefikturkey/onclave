---
created: 2026-02-11
completed: 2026-02-11
status: done
blocked_by: ws4, ws5
parent: plan.md
---

# Team Plan: WS7 — /yt Command Alignment with Unified Pipeline

## Objective

Update the `/yt` command tooling at `~/.dotfiles/claude/commands/yt/` to align with the
unified pipeline changes from WS1-WS5. The ingest API response contract changed (`job_id`
replaces `summary`/`classification_status`), new job management endpoints exist, and the
scripts have accumulated technical debt (hardcoded API_BASE, duplicated RequestSigner,
duplicated load_secrets_file, duplicated extract_video_id).

## Depends On

- WS4 (router cutover: `YouTubeIngestResponse` now returns `job_id`, job management endpoints exist)
- WS5 (observability: verbose job details with error_stage, audit events)

## Project Context

- **Language**: Python 3.11+
- **Location**: `~/.dotfiles/claude/commands/yt/` (OUTSIDE menos repo)
- **Test command**: `cd ~/.dotfiles/claude/commands/yt && uv run pytest tests/ -v`
- **Lint command**: N/A (no ruff configured in yt/ pyproject.toml)
- **Dependencies**: httpx, cryptography, youtube-transcript-api, google-api-python-client

## Current State

### Scripts Inventory

| File | Purpose | Issues |
|------|---------|--------|
| `ingest_video.py` | Ingest video via menos API | Hardcoded `API_BASE`, accesses `data.get("summary")` which no longer exists, no `job_id` handling, duplicates `RequestSigner` |
| `test_search.py` | Test semantic search API | Hardcoded `API_BASE` + `host`, inline RFC 9421 signing code, duplicates signing logic |
| `fetch_transcript.py` | Fetch YouTube transcript | Duplicates `load_secrets_file()` and `extract_video_id()` |
| `fetch_metadata.py` | Fetch YouTube metadata | Duplicates `load_secrets_file()` and `extract_video_id()` |
| `pyproject.toml` | Package config | Missing entry points for new scripts |

### API Response Contract Change (WS4)

**Before (pre-WS4):**
```python
class YouTubeIngestResponse:
    id: str
    video_id: str
    title: str
    transcript_length: int
    chunks_created: int
    file_path: str
    classification_status: str | None  # REMOVED
    summary: str | None               # REMOVED
```

**After (WS4+):**
```python
class YouTubeIngestResponse:
    id: str
    video_id: str
    title: str
    transcript_length: int
    chunks_created: int
    file_path: str
    job_id: str | None  # NEW — pipeline job ID for async tracking
```

### New API Endpoints Available (WS4+)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/v1/jobs/{job_id}` | GET | Job status (minimal or `?verbose=true`) |
| `/api/v1/jobs` | GET | List jobs (filter by `content_id`, `status`) |
| `/api/v1/jobs/{job_id}/cancel` | POST | Cancel a pending/processing job |
| `/api/v1/content/{content_id}/reprocess` | POST | Reprocess content (`?force=true`) |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| ws7-builder-1 | builder | sonnet | Shared modules + update existing scripts |
| ws7-builder-2 | builder | sonnet | New job management scripts |
| ws7-builder-3 | builder | sonnet | Tests for all changes |
| ws7-validator | validator-heavy | sonnet | Wave validation |

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T13a: Shared modules + update existing | 8 | architecture | sonnet | builder |
| T13b: New job management scripts | 3 | feature | sonnet | builder |
| T13c: Tests | 4 | feature | sonnet | builder |

## Tasks

### Task 13a: Extract shared modules and update existing scripts

- **Owner**: ws7-builder-1
- **Blocked By**: none
- **Description**: Eliminate code duplication by extracting shared modules. Update all existing scripts to use them. Fix `ingest_video.py` response handling for the unified pipeline.

  **Step 13a.1: Create `signing.py`**

  Extract `RequestSigner` class from `ingest_video.py` into `~/.dotfiles/claude/commands/yt/signing.py`:
  ```python
  class RequestSigner:
      """Signs HTTP requests per RFC 9421 using ed25519 keys."""
      def __init__(self, private_key, key_id): ...
      @classmethod
      def from_file(cls, path, password=None): ...
      def sign_request(self, method, path, host, body=None) -> dict[str, str]: ...
  ```

  The class is identical to what's in `ingest_video.py` lines 20-99. Move it, don't rewrite.

  **Step 13a.2: Create `api_config.py`**

  Consolidate duplicated configuration loading:
  ```python
  """Shared configuration for menos API client scripts."""
  import os
  import re
  from pathlib import Path
  from urllib.parse import urlparse

  DEFAULT_API_BASE = "http://192.168.16.241:8000/api/v1"

  def load_secrets_file() -> None:
      """Load secrets from ~/.dotfiles/.env if env vars not set."""
      # Same implementation currently in fetch_transcript.py:25-50
      ...

  def get_api_base() -> str:
      """Get menos API base URL from MENOS_API_BASE env var or default."""
      load_secrets_file()
      return os.getenv("MENOS_API_BASE", DEFAULT_API_BASE)

  def get_api_host() -> str:
      """Extract host:port from API base URL."""
      parsed = urlparse(get_api_base())
      return parsed.netloc
  ```

  Also consolidate `extract_video_id()` here (union of all 3 existing implementations — include the `shorts` pattern from `ingest_video.py`):
  ```python
  def extract_video_id(url_or_id: str) -> str:
      """Extract video ID from YouTube URL or return as-is if already an ID."""
      ...
  ```

  **Step 13a.3: Update `ingest_video.py`**

  - Remove `RequestSigner` class (import from `signing`)
  - Remove `extract_video_id` function (import from `api_config`)
  - Remove hardcoded `API_BASE` (use `get_api_base()`)
  - Remove inline `urlparse` import and usage (use `get_api_host()`)
  - Fix response handling:
    - Remove `data.get("summary")` access (line 190-194) — field no longer exists
    - Show `job_id` from response: `print(f"Job ID: {data.get('job_id', 'N/A')}")`
  - Add `--wait` flag: if set, poll `GET /api/v1/jobs/{job_id}` every 3s until terminal state (completed/failed/cancelled), then print final status
  - Add `--verbose` flag: show verbose job details when polling completes

  **Step 13a.4: Update `test_search.py`**

  - Remove all inline signing code (lines 22-53)
  - Import `RequestSigner` from `signing`
  - Import `get_api_base`, `get_api_host` from `api_config`
  - Use `RequestSigner.from_file()` instead of manual key loading

  **Step 13a.5: Update `fetch_transcript.py`**

  - Remove `load_secrets_file()` function (lines 25-50)
  - Remove module-level `load_secrets_file()` call (line 54)
  - Remove `extract_video_id()` function (lines 57-73)
  - Import from `api_config`: `load_secrets_file`, `extract_video_id`
  - Call `load_secrets_file()` at module level (same position)

  **Step 13a.6: Update `fetch_metadata.py`**

  - Same changes as fetch_transcript.py:
    - Remove `load_secrets_file()` (lines 24-41)
    - Remove module-level call (line 45)
    - Remove `extract_video_id()` (lines 48-63)
    - Import from `api_config`

- **Acceptance Criteria**:
  - [ ] `signing.py` exists with `RequestSigner` class
  - [ ] `api_config.py` exists with `load_secrets_file`, `get_api_base`, `get_api_host`, `extract_video_id`
  - [ ] `ingest_video.py` has no `RequestSigner` class, no `extract_video_id` function, no hardcoded `API_BASE`
  - [ ] `ingest_video.py` shows `job_id` from response, does NOT access `summary` field
  - [ ] `ingest_video.py` supports `--wait` flag for job polling
  - [ ] `test_search.py` has no inline signing code, uses shared `RequestSigner`
  - [ ] `fetch_transcript.py` has no `load_secrets_file` or `extract_video_id` defined locally
  - [ ] `fetch_metadata.py` has no `load_secrets_file` or `extract_video_id` defined locally
  - [ ] All scripts still work as CLI tools (same arg interface, minus additions)

### Task 13b: Create job management scripts

- **Owner**: ws7-builder-2
- **Blocked By**: Task 13a (uses `signing.py` and `api_config.py`)
- **Description**: Create new CLI scripts for the job management API endpoints added in WS4.

  **Step 13b.1: Create `check_job.py`**

  ```python
  """Check pipeline job status via menos API.

  Usage:
      uv run check_job.py <job_id> [--verbose] [--wait] [--cancel]
      uv run check_job.py <job_id> --wait --verbose
  """
  ```

  Features:
  - `check_job.py <job_id>` — Show minimal job status (status, content_id, timestamps)
  - `--verbose` — Show full details (error_code, error_message, error_stage, resource_key, pipeline_version, metadata)
  - `--wait` — Poll every 3s until terminal state, then print final status
  - `--cancel` — Cancel the job (POST to cancel endpoint)
  - Uses `RequestSigner` from `signing.py`
  - Uses `get_api_base`, `get_api_host` from `api_config.py`

  **Step 13b.2: Create `reprocess.py`**

  ```python
  """Reprocess content through the unified pipeline via menos API.

  Usage:
      uv run reprocess.py <content_id> [--force] [--wait] [--verbose]
  """
  ```

  Features:
  - `reprocess.py <content_id>` — Submit content for reprocessing
  - `--force` — Force reprocessing even if already completed
  - `--wait` — Poll job status until terminal (uses job_id from response)
  - `--verbose` — Show verbose job details when polling completes
  - Uses shared signing and config modules

  **Step 13b.3: Update `pyproject.toml`**

  Add new entry points:
  ```toml
  [project.scripts]
  fetch-transcript = "fetch_transcript:main"
  fetch-metadata = "fetch_metadata:main"
  ingest-video = "ingest_video:main"
  check-job = "check_job:main"
  reprocess = "reprocess:main"
  ```

  Bump version to `4.0.0` (breaking: shared module extraction changes import structure).

- **Acceptance Criteria**:
  - [ ] `check_job.py` exists with status, --verbose, --wait, --cancel support
  - [ ] `reprocess.py` exists with --force, --wait, --verbose support
  - [ ] Both scripts use shared `signing.py` and `api_config.py`
  - [ ] Both scripts use `argparse` for CLI (consistent with existing scripts)
  - [ ] `pyproject.toml` has new entry points and version `4.0.0`
  - [ ] All scripts handle HTTP errors gracefully (non-zero exit code)

### Task 13c: Tests for all changes

- **Owner**: ws7-builder-3
- **Blocked By**: Task 13a, Task 13b
- **Description**: Add test coverage for shared modules, updated scripts, and new scripts.

  **Step 13c.1: Create `tests/test_signing.py`**

  - Test `RequestSigner.from_file()` with mocked SSH key
  - Test `sign_request()` produces valid signature headers
  - Test `sign_request()` includes `content-digest` when body is present
  - Test `sign_request()` omits `content-digest` when no body
  - Test non-ed25519 key raises `ValueError`

  **Step 13c.2: Create `tests/test_api_config.py`**

  - Test `load_secrets_file()` loads from `~/.dotfiles/.env`
  - Test `load_secrets_file()` doesn't overwrite existing env vars
  - Test `get_api_base()` returns env var when set
  - Test `get_api_base()` returns default when not set
  - Test `get_api_host()` extracts host:port correctly
  - Test `extract_video_id()` handles all URL formats (watch, youtu.be, shorts, embed, raw ID)
  - Test `extract_video_id()` raises ValueError for invalid input

  **Step 13c.3: Create `tests/test_ingest_video.py`**

  - Test `main()` with mocked httpx shows `job_id` in output
  - Test `main()` does NOT access `summary` field
  - Test `--wait` flag polls job status until terminal state
  - Test `--wait` exits on `completed`, `failed`, `cancelled`

  **Step 13c.4: Create `tests/test_check_job.py`**

  - Test status display (minimal and verbose)
  - Test `--wait` polling behavior
  - Test `--cancel` sends POST to cancel endpoint
  - Test 404 handling for nonexistent job
  - Test HTTP error handling

  **Step 13c.5: Update `tests/test_fetch_transcript.py`**

  - Update `extract_video_id` import path: `from api_config import extract_video_id`
  - Verify existing tests still pass with shared module

  **Step 13c.6: Update `tests/test_fetch_metadata.py`**

  - Update `extract_video_id` import path: `from api_config import extract_video_id`
  - Update `extract_urls` import path (stays in `fetch_metadata`)
  - Verify existing tests still pass with shared module

- **Acceptance Criteria**:
  - [ ] `tests/test_signing.py` exists with signing tests
  - [ ] `tests/test_api_config.py` exists with config + video ID tests
  - [ ] `tests/test_ingest_video.py` exists with response contract tests
  - [ ] `tests/test_check_job.py` exists with job management tests
  - [ ] `tests/test_fetch_transcript.py` updated for shared module imports
  - [ ] `tests/test_fetch_metadata.py` updated for shared module imports
  - [ ] All tests pass: `cd ~/.dotfiles/claude/commands/yt && uv run pytest tests/ -v`

## Execution Waves

### Wave 1
- T13a: Shared modules + update existing scripts [sonnet] -- ws7-builder-1

### Wave 1 Validation
- V1: Validate wave 1 [sonnet] -- ws7-validator, blockedBy: [T13a]

### Wave 2 (parallel)
- T13b: New job management scripts [sonnet] -- ws7-builder-2, blockedBy: [V1]
- T13c: Tests for all changes [sonnet] -- ws7-builder-3, blockedBy: [V1]

### Wave 2 Validation
- V2: Validate wave 2 [sonnet] -- ws7-validator, blockedBy: [T13b, T13c]

## Dependency Graph

```
Wave 1: T13a (shared modules + existing updates) --> V1
Wave 2: T13b (new scripts) + T13c (tests)        --> V2
         (parallel, both blocked by V1)
```

## Files to Create

| File | Task | Purpose |
|------|------|---------|
| `signing.py` | T13a | Shared RFC 9421 request signing |
| `api_config.py` | T13a | Shared secrets loading, API base config, video ID extraction |
| `check_job.py` | T13b | Job status / cancel CLI |
| `reprocess.py` | T13b | Content reprocess CLI |
| `tests/test_signing.py` | T13c | Signing module tests |
| `tests/test_api_config.py` | T13c | Config module tests |
| `tests/test_ingest_video.py` | T13c | Ingest response + polling tests |
| `tests/test_check_job.py` | T13c | Job management tests |

## Files to Modify

| File | Task | Changes |
|------|------|---------|
| `ingest_video.py` | T13a | Remove RequestSigner/extract_video_id/API_BASE, use shared modules, handle job_id, add --wait/--verbose |
| `test_search.py` | T13a | Remove inline signing, use shared RequestSigner + api_config |
| `fetch_transcript.py` | T13a | Remove load_secrets_file/extract_video_id, import from api_config |
| `fetch_metadata.py` | T13a | Remove load_secrets_file/extract_video_id, import from api_config |
| `pyproject.toml` | T13b | Add check-job + reprocess entry points, bump to 4.0.0 |
| `tests/test_fetch_transcript.py` | T13c | Update extract_video_id import path |
| `tests/test_fetch_metadata.py` | T13c | Update extract_video_id import path |
| `tests/conftest.py` | T13c | No changes expected (path setup still works) |

## Files NOT to Touch

- `tests/test_fetch_transcript.py` test logic (only import paths change)
- `tests/test_fetch_metadata.py` test logic (only import paths change)
- menos API code (this workstream is client-side only)

## Verification Commands

```bash
cd ~/.dotfiles/claude/commands/yt
uv run pytest tests/ -v
```

No ruff configured for this project, but scripts should follow existing code style (argparse CLI, consistent error handling, stderr for status messages).

## Final Step: Commit

After validation passes:
- Stage all changed files in `~/.dotfiles/claude/commands/yt/`
- Commit message: `feat!: align yt commands with unified pipeline API (job-based response)`
- This is a breaking change (version 4.0.0) because:
  - `ingest_video.py` output format changes (shows job_id, no summary)
  - Import structure changes (shared modules)
  - New scripts added
