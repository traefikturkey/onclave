# Team Plan: Smoke Test Expansion

## Objective
Add comprehensive smoke tests for all read (GET) endpoints across the menos API. Currently only 8 of ~33 endpoints are smoke-tested (health, auth, search). Need 4 new test files covering content, youtube, graph, and entities endpoints, plus conftest fixture updates. This ensures deployed API health is verified after every deploy.

## Project Context
- **Language**: Python (pyproject.toml)
- **Test command**: `cd api && uv run pytest tests/smoke/ -m smoke --co -q` (collect-only, no live server needed for syntax check)
- **Lint command**: `cd api && uv run ruff check tests/smoke/`
- **Working directory**: `C:\Projects\Personal\menos`

## Team Members
| Name | Agent | Role |
|------|-------|------|
| smoke-builder | builder (sonnet) | Implement conftest fixtures + 4 test files |
| smoke-validator | validator (haiku) | Lint, collect tests, verify structure |

## Tasks

### Task 1: Implement smoke tests for all read endpoints
- **Owner**: smoke-builder
- **Blocked By**: none
- **Description**: Update `api/tests/smoke/conftest.py` with shared fixtures and create 4 new test files with 26 total tests. See `.specs/smoke-test-expansion/plan.md` and the existing plan at `~/.claude/plans/zazzy-discovering-hejlsberg.md` for full endpoint details, response structures, and gotchas.
- **Files to create/modify**:
  - `api/tests/smoke/conftest.py` (modify) — add `_smoke_authed_get` helper, `smoke_first_content_id`, `smoke_first_youtube_video_id`, `smoke_first_entity_id` fixtures
  - `api/tests/smoke/test_content_smoke.py` (create) — 8 tests: content list, get, links, backlinks, tags
  - `api/tests/smoke/test_youtube_smoke.py` (create) — 6 tests: video list, get, channels
  - `api/tests/smoke/test_graph_smoke.py` (create) — 5 tests: graph, neighborhood
  - `api/tests/smoke/test_entities_smoke.py` (create) — 7 tests: entities list, get, topics, duplicates, content
- **Acceptance Criteria**:
  - [ ] conftest.py has 3 new session-scoped ID-lookup fixtures + helper function
  - [ ] 4 new test files exist with 26 total test methods
  - [ ] All tests use `@pytest.mark.smoke` marker
  - [ ] All tests follow existing patterns (class-based, urlparse for host, smoke_authed_headers)
  - [ ] Each auth-required endpoint has a 401 test (no auth) and 200 test (with auth)
  - [ ] Structure tests use pytest.skip() when no data exists
  - [ ] YouTube list fixture extracts `video_id` not `id`
  - [ ] Lines <= 100 chars (ruff E501)
- **Verification Command**: `cd api && uv run ruff check tests/smoke/ && uv run pytest tests/smoke/ -m smoke --co -q`

### Task 2: Validate implementation
- **Owner**: smoke-validator
- **Blocked By**: Task 1
- **Description**: Run linters and test collection on the builder's output. Verify all files exist, test count matches, and code quality passes.
- **Acceptance Criteria**:
  - [ ] `uv run ruff check tests/smoke/` passes with zero errors
  - [ ] `uv run pytest tests/smoke/ -m smoke --co -q` collects all 26 new tests (34+ total with existing)
  - [ ] No hardcoded IPs, secrets, or debug statements in test files
  - [ ] All test classes use `@pytest.mark.smoke` decorator
  - [ ] conftest fixtures are session-scoped

## Dependency Graph
Task 1 (smoke-builder) → Task 2 (smoke-validator)
