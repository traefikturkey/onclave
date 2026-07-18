# Project-specific Claude Instructions

## Rules

Project context is in `.claude/rules/`:
- `architecture.md` — Project overview, directory tree, design patterns, code style
- `api-reference.md` — Endpoints, config env vars (auto-loaded for `api/` files)
- `schema.md` — SurrealDB schema (auto-loaded for `api/` files)
- `dev-commands.md` — Dev workflow, testing, linting, scripts
- `versioning.md` — Semantic versioning policy and Makefile bump commands
- `migrations.md` — Migration system (auto-loaded for migration files)
- `deployment.md` — Ansible deploy, version gate, Docker Desktop safety rule
- `troubleshooting.md` — Server access, logs, common issues
- `gotchas.md` — Cross-platform issues, container gotchas

Available reusable skills are in `.claude/skills/`.

- LLM architecture boundary: all feature `generate()` calls must go through DI-provided metered wrappers; do not call raw provider implementations directly in feature code.

- Clarifications: Default to `AskUserQuestion` when clarification is needed. Exception: if the user explicitly requests direct in-chat discussion (for example, one-question-at-a-time 1-3-1), respond directly in chat and do not use `AskUserQuestion` for that discussion flow.

## SurrealDB Gotchas (Query-Side)

- **RecordID vs string in queries**: `chunk.content_id` stores plain strings (e.g., `"abc123"`), NOT RecordID objects. When building `WHERE content_id INSIDE $ids`, the `$ids` list must contain plain strings. Passing `RecordID("content", "abc")` objects will silently match nothing — SurrealDB does not error on type mismatches, it just returns empty results.
- **Always check field types before querying**: When a query returns unexpected empty results, the FIRST thing to check is whether the parameterized values match the stored field types. Use `scripts/query.py` to inspect actual stored values.
- **Test queries against real data**: Mock-based unit tests will not catch RecordID/string mismatches. Use `scripts/query.py` or smoke tests to verify queries return expected results.
- **Verify technology claims**: Before asserting SurrealDB doesn't support a feature (e.g., conditional/partial indexes), search the official documentation. SurrealDB evolves rapidly and training data may be stale.

## Migration Rules

- **Test migrations locally first**: Before deploying, verify migration SQL against a dev instance or via `scripts/query.py`. Do NOT use production as your first test environment.
- **Check migration logs after deploy**: SSH into the server and check `docker logs menos-api` to verify migrations succeeded. The app catches migration errors and continues — don't assume success.
- **Never simplify failing SQL without understanding why**: If a migration's SQL fails, research the correct syntax. Removing a clause changes the semantics.

## Root Cause Investigation

- **Investigate before fixing**: When data is wrong (e.g., chunk_count=0), query the DB to understand why before changing code. Use `scripts/query.py` for ad-hoc inspection.
- **Never mask symptoms**: If a field shows wrong data, fix the data pipeline. Don't remove the field from the response.
- **Fix forward, don't remove**: If a feature doesn't work, fix it. Don't delete it and call that a fix.
- **Port ALL query logic when moving code**: When consolidating routers, audit every clause (SELECT, WHERE, ORDER BY, LIMIT). Missing ORDER BY caused non-deterministic results.

## Debugging Checklist (Before Deploying Fixes)

1. Can you reproduce the issue locally or via `scripts/query.py`?
2. Do you understand the root cause, or are you guessing?
3. Have you checked the actual data types stored in SurrealDB?
4. Have you verified the fix returns correct results, not just "no error"?
5. Have you run the migration/change locally before deploying?
