# Team Plan: General-Purpose SurrealDB Query Tool

## Objective
Create a reusable query script (`api/scripts/query.py`) that accepts raw SurrealQL and returns formatted results, plus a schema reference file stored in Claude's auto-memory so efficient queries can be constructed without exploring the codebase each time.

## Project Context
- **Language**: Python (uv, FastAPI, Pydantic)
- **Test command**: `make test` / `cd api && uv run pytest -v`
- **Lint command**: `make lint` / `cd api && uv run ruff check .`
- **DB**: SurrealDB (accessed via `surrealdb` Python SDK, sync API)
- **Auth**: SSH key signing (not needed for direct DB queries from scripts)

## Team Members
| Name | Agent | Role |
|------|-------|------|
| query-tool-builder | general-purpose (sonnet) | Implement query script + schema memory |
| query-tool-validator | general-purpose (haiku) | Verify output |

## Tasks

### Task 1: Build query.py script
- **Owner**: query-tool-builder
- **Blocked By**: none
- **Description**: Create `api/scripts/query.py` that:
  1. Connects directly to SurrealDB using `get_storage_context()` from `menos.services.di`
  2. Accepts a SurrealQL query string as a CLI argument
  3. Executes the query via `surreal.db.query()`
  4. Formats output as a readable table (or JSON with `--json` flag)
  5. Handles SurrealDB v2 result format (direct list vs wrapped `{"result": [...]}`)
  6. Handles RecordID objects (convert to string via `.id` attribute)
  7. Read-only safety: reject queries starting with DELETE, UPDATE, CREATE, REMOVE, DEFINE (case-insensitive)

  **Key references:**
  - `api/menos/services/di.py` — `get_storage_context()` async context manager yields `(minio, surreal)`
  - `api/menos/services/storage.py` — `SurrealDBRepository`, see `list_content()` at line 184 for query pattern and result parsing
  - `api/scripts/refetch_metadata.py` — example of script using `get_storage_context()`
  - Run with: `cd api && PYTHONPATH=. uv run python scripts/query.py "SELECT ..."`

- **Acceptance Criteria**:
  - [ ] `query.py` accepts SurrealQL as first positional arg
  - [ ] Connects to SurrealDB using existing `get_storage_context()`
  - [ ] Pretty-prints results as a table by default
  - [ ] Supports `--json` flag for raw JSON output
  - [ ] Rejects mutating queries (DELETE, UPDATE, CREATE, REMOVE, DEFINE)
  - [ ] Handles RecordID objects and SurrealDB v2 result format
  - [ ] Passes `ruff check`
- **Verification Command**: `make lint`

### Task 2: Write schema to Claude auto-memory
- **Owner**: query-tool-builder
- **Blocked By**: none
- **Description**: Write a schema reference file to `~/.claude/projects/C--Projects-Personal-menos/memory/schema.md` and link it from `MEMORY.md`. The schema file should document:
  1. SurrealDB tables: `content`, `chunk`
  2. All fields with types for each table (from `ContentMetadata` and `ChunkModel` in `api/menos/models.py`)
  3. The `metadata` dict structure for YouTube content (video_id, language, segment_count, channel_title, duration_seconds)
  4. MinIO file layout (`youtube/{video_id}/transcript.txt`, `metadata.json`, `summary.md`)
  5. Common query patterns (filter by content_type, order by created_at, count, etc.)
  6. How to run: `cd api && PYTHONPATH=. uv run python scripts/query.py "QUERY"`

- **Acceptance Criteria**:
  - [ ] Schema file exists at the memory path
  - [ ] MEMORY.md links to schema.md
  - [ ] Documents both `content` and `chunk` tables with all fields
  - [ ] Documents YouTube metadata dict fields
  - [ ] Includes example queries

### Task 3: Validate implementation
- **Owner**: query-tool-validator
- **Blocked By**: Task 1, Task 2
- **Description**: Run linters, tests, and verify the query script works correctly
- **Acceptance Criteria**:
  - [ ] `make lint` passes
  - [ ] `make test` passes
  - [ ] `query.py` rejects a DELETE query
  - [ ] Schema memory file is valid markdown
  - [ ] No debug statements or hardcoded secrets

### Task 4: Clean up old scripts
- **Owner**: query-tool-builder
- **Blocked By**: Task 3
- **Description**: Remove `api/scripts/latest_transcript.py` since `query.py` replaces it. The same result is achieved with:
  `query.py "SELECT title, metadata.video_id, created_at FROM content WHERE content_type = 'youtube' ORDER BY created_at DESC LIMIT 1"`
- **Acceptance Criteria**:
  - [ ] `api/scripts/latest_transcript.py` is deleted
  - [ ] `make lint` still passes

## Dependency Graph
Task 1 (builder) ──┐
                    ├──→ Task 3 (validator) ──→ Task 4 (builder)
Task 2 (builder) ──┘
