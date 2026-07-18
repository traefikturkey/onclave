# Team Plan: signed-request-cli

## Objective
Create a general-purpose CLI script (`api/scripts/signed_request.py`) for making RFC 9421-signed HTTP requests to the menos API. The troubleshooting docs reference this script but it doesn't exist. Needed for ad-hoc API operations (DELETE, PATCH, POST) that require authentication. Also update `.claude/rules/dev-commands.md` with usage documentation.

## Project Context
- **Language**: Python 3.12+
- **Test command**: `cd api && uv run pytest tests/unit/ -q`
- **Lint command**: `cd api && uv run ruff check scripts/signed_request.py`

## Team Members
| Name | Agent | Role |
|------|-------|------|
| signed-request-cli-builder | builder (sonnet) | Implement script and docs |
| signed-request-cli-validator | validator (haiku) | Verify output |

## Tasks

### Task 1: Implement signed_request.py and update docs
- **Owner**: signed-request-cli-builder
- **Blocked By**: none
- **Description**: Create `api/scripts/signed_request.py` and add entry to `.claude/rules/dev-commands.md`.

  **Script requirements:**
  - argparse with positional args: `method` (GET/POST/PUT/PATCH/DELETE), `path` (/api/v1/...), optional `body` (JSON string)
  - `--key` flag for SSH key path (default `~/.ssh/id_ed25519`)
  - `--url` flag for base URL (default from `SMOKE_TEST_URL` env var, fallback `http://localhost:8000`)
  - `--verbose` flag to print request details
  - Use `menos.client.signer.RequestSigner.from_file()` to load key and sign requests
  - Use `httpx` for HTTP calls (already a project dependency)
  - Set `content-type: application/json` when body is provided
  - Pretty-print JSON responses with `json.dumps(indent=2)`, raw text otherwise
  - Exit code 0 for 2xx, 1 for errors (print status code + body on error)
  - Follow existing script patterns in `api/scripts/` (see `query.py`, `delete_video.py`)

  **Docs update:**
  - Add to the Scripts section of `.claude/rules/dev-commands.md`:
    ```
    PYTHONPATH=. uv run python scripts/signed_request.py METHOD /path [body]  # Authenticated API requests
    ```

  **Key files to reference:**
  - `api/menos/client/signer.py` — RequestSigner class (from_file, sign_request methods)
  - `api/tests/smoke/conftest.py` — example of how sign_request is used with httpx
  - `api/scripts/query.py` — example script pattern (argparse, error handling)
  - `.claude/rules/dev-commands.md` — where to add docs

- **Acceptance Criteria**:
  - [ ] `api/scripts/signed_request.py` exists and is executable
  - [ ] Script supports GET, POST, PUT, PATCH, DELETE methods
  - [ ] Script uses `RequestSigner.from_file()` from `menos.client.signer`
  - [ ] Script accepts `--key`, `--url`, `--verbose` flags
  - [ ] JSON responses are pretty-printed
  - [ ] Non-2xx responses print status code and exit 1
  - [ ] `.claude/rules/dev-commands.md` has new entry in Scripts section
  - [ ] `uv run ruff check scripts/signed_request.py` passes
- **Verification Command**: `cd api && uv run ruff check scripts/signed_request.py`

### Task 2: Validate implementation
- **Owner**: signed-request-cli-validator
- **Blocked By**: Task 1
- **Description**: Run linter, verify script structure, and check documentation update
- **Acceptance Criteria**:
  - [ ] `uv run ruff check scripts/signed_request.py` passes with no errors
  - [ ] Script imports resolve correctly (`menos.client.signer`, `httpx`, `argparse`)
  - [ ] No hardcoded secrets, debug prints, or TODO comments
  - [ ] `.claude/rules/dev-commands.md` contains the new script entry
  - [ ] Script handles missing key file gracefully (error message, not stack trace)
  - [ ] Unit tests still pass: `uv run pytest tests/unit/ -q`
- **Verification Command**: `cd api && uv run ruff check scripts/signed_request.py && uv run pytest tests/unit/ -q`

## Dependency Graph
Task 1 (builder) → Task 2 (validator)
