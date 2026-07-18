# Gotchas

## CRLF/LF in Ansible Container
Windows git uses `core.autocrlf=input` — stores LF in index, CRLF on disk. The Linux Ansible container must also set `core.autocrlf=input` or `git status` reports every text file as modified. This is handled in deploy.yml pre-flight block.

## Git safe.directory in Containers
Git 2.35.2+ rejects operations on repos owned by different UIDs. Mounted `/project` in Docker needs `git config --global --add safe.directory /project` before any git commands.

## Ansible Container Image Cache
Changes to `infra/ansible/Dockerfile` require explicit rebuild: `docker compose build --no-cache ansible`. The old cached image runs silently otherwise.

## Docker ARG Placement
`ARG GIT_SHA` changes every commit. Place after all `COPY` and `RUN` steps in Dockerfile to avoid busting the dependency install cache layer.

## Mock side_effect for Paginated Loops
A while loop calling a paginated method needs N+1 mock `side_effect` entries — N for data batches plus 1 empty return `([], total)` to break the loop. Missing the terminator causes `StopIteration`.

## SurrealDB Vector Search Requires NONE Guard
`vector::similarity::cosine(embedding, $embedding)` errors if `embedding` is `NONE` on any row. The error returns as a string (not a list), silently breaking result parsing. Always add `WHERE embedding != NONE AND ...` before cosine similarity filters.

## SurrealDB RecordID Objects (Read Side)
The surrealdb Python client returns `RecordID` objects (not strings) for `id`, `source`, `target`, and other reference fields. Always convert before passing to Pydantic models. Use the `_stringify_record_id()`, `_parse_content()`, `_parse_chunk()`, `_parse_link()`, or `_parse_entity()` helpers in `storage.py`. Unit tests with mocked DB won't catch this — smoke tests against the live API are the safety net.

## SurrealDB RecordID Objects (Write Side)
Parameterized `WHERE id = $param` and `WHERE ref_field = $param` clauses require `RecordID` objects, not strings. `f"content:{id}"` silently matches nothing — the UPDATE/SELECT/DELETE succeeds but affects zero rows. Use `RecordID("content", id)` for all query params that compare against `id` or `record<T>` fields. Direct `db.select/update/delete("content:{id}")` calls accept string format.

## SurrealDB JWT Token Expiry
Root signin tokens expire after 1 hour (3600s). Long-running scripts must re-authenticate periodically or all queries fail with `401 Client Error: Unauthorized`. Use `time.monotonic()` to track elapsed time and call `db.signin()` + `db.use()` before the token expires (e.g., every 45 minutes).

## Shell Env Vars Override .env File
Pydantic `BaseSettings` loads from `.env` but shell environment variables take priority. If a shell var like `MINIO_URL=http://host:9000` exists, it overrides the `.env` value `host:9000`, breaking the Minio client which expects `host:port` without scheme. Fix: `unset MINIO_URL` before running scripts, or ensure shell vars match expected format.

## Test Content Not Appearing in Queries
Content tagged with "test" is excluded by default from `GET /api/v1/content` and `POST /api/v1/search`. Pass `exclude_tags=` (empty) to include test content, or `tags=test` to find it specifically. See `test-content.md` for full details.

## SurrealDB Type Mismatches Are Silent

SurrealDB does not raise errors when comparing incompatible types in WHERE clauses. A query like `WHERE content_id INSIDE $ids` will silently return zero rows if `$ids` contains RecordID objects but `content_id` stores plain strings (or vice versa). This is the most dangerous SurrealDB gotcha because:
- The query succeeds (no error)
- The result is empty (looks like "no matching data")
- Unit tests with mocks won't catch it
- Only live queries against real data reveal the mismatch

**Debug approach**: Use `scripts/query.py` to inspect actual stored values and types before building parameterized queries.

## Don't Assume Feature Gaps — Verify

Before claiming SurrealDB doesn't support a specific feature, ALWAYS:
1. Search the official documentation at surrealdb.com/docs
2. Search GitHub issues for the project
3. Check the latest release notes

SurrealDB adds features rapidly. Conditional indexes, computed fields, and other advanced features may exist even if training data suggests otherwise.

## ORDER BY When Porting Queries

When moving query logic between routers (e.g., from a deleted YouTube router to the content router), port ALL query clauses — especially ORDER BY. Missing ORDER BY causes non-deterministic result ordering that may not be noticed in small datasets but breaks pagination and user expectations.
