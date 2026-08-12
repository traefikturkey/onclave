# Menos Parity Contract

Frozen inventory for porting the Menos content vault into the Onclave core
service. Source of truth: the generated FastAPI OpenAPI document from the
retired Menos service (33 paths, 39 operations) plus every real client call site in
the operator dotfiles (`tools/menos-youtube/`, `claude/hooks/menos-circuit/`,
`claude/shared/yt-instructions.md`) and the deployment health gates.

Dispositions:

- `keep` -- has a real consumer; behavior, consumed fields, and error
  semantics below are the port contract.
- `keep-thin` -- no client call site; ported as a thin equivalent because it
  is cheap and operationally useful (key management, curation, diagnostics).
- `drop-confirmed` -- no consumer; dropped from the unified API. Confirmed by
  the operator on 2026-08-11. Pipeline-side extraction (summary, tags,
  topics, entities) is retained and remains visible through
  `GET /api/v1/content/{id}`; only the browse/graph endpoints are dropped.

## Authentication

All routes except `GET /health` and `GET /ready` require RFC 9421 HTTP
message signatures with Ed25519 keys. Normative pair: the retired server verifier and client signing in the dotfiles
`tools/menos-youtube/signing.py` (signs method, path with query, host, and
content digest for bodies; key loaded from the operator SSH Ed25519 key;
server authorizes against a mounted `authorized_keys` file with reload via
`POST /api/v1/auth/keys/reload`). The port must accept signatures produced by
the existing unmodified client signer.

## Error semantics consumers branch on

- Success for every kept operation is `200` (including creates: ingest,
  annotations, reprocess, cancel). Do not change create responses to `201`.
- Clients branch on `404` for: content detail, job detail, job cancel,
  reprocess target, and YouTube channel lookup (client falls back to the
  YouTube Data API on channel `404`).
- `channel_videos.py` treats `>=500` as retryable transport failure and any
  other non-`200` as terminal; remaining clients treat any non-`200` as
  terminal and print the status code.
- The circuit probe treats a `200` from `GET /health` within 3 seconds as
  service-up; anything else marks the service down.

## Route dispositions

| Operation | Disposition | Consumers |
| --- | --- | --- |
| GET /health | keep | circuit probe, deployment health gate |
| GET /ready | keep | deployment readiness gate |
| GET /api/v1/auth/keys | keep-thin | operational key inspection |
| POST /api/v1/auth/keys/reload | keep-thin | key rotation workflow |
| GET /api/v1/auth/whoami | keep-thin | signature debugging |
| GET /api/v1/content | keep | list_videos.py, find_content.py |
| POST /api/v1/content | drop-confirmed | none (ingest is the used create path) |
| GET /api/v1/content/stats | keep-thin | none |
| GET /api/v1/content/tags | keep-thin | none |
| GET /api/v1/content/{id} | keep | get_content.py, backfill.py |
| PATCH /api/v1/content/{id} | keep-thin | single-user curation |
| DELETE /api/v1/content/{id} | keep-thin | single-user curation |
| GET /api/v1/content/{id}/annotations | keep-thin | read pair of kept write |
| POST /api/v1/content/{id}/annotations | keep | post_annotation.py |
| GET /api/v1/content/{id}/backlinks | drop-confirmed | none |
| GET /api/v1/content/{id}/chunks | keep-thin | diagnostics |
| GET /api/v1/content/{id}/download | keep | get_content.py --transcript-only |
| GET /api/v1/content/{id}/entities | drop-confirmed | none |
| GET /api/v1/content/{id}/links | drop-confirmed | none |
| GET /api/v1/content/{id}/related | drop-confirmed | none |
| POST /api/v1/content/{id}/reprocess | keep | reprocess.py |
| GET /api/v1/entities | drop-confirmed | none |
| GET /api/v1/entities/duplicates | drop-confirmed | none |
| GET /api/v1/entities/topics | drop-confirmed | none |
| GET /api/v1/entities/{id} | drop-confirmed | none |
| PATCH /api/v1/entities/{id} | drop-confirmed | none |
| DELETE /api/v1/entities/{id} | drop-confirmed | none |
| GET /api/v1/entities/{id}/content | drop-confirmed | none |
| GET /api/v1/graph | drop-confirmed | none |
| GET /api/v1/graph/neighborhood/{id} | drop-confirmed | none |
| POST /api/v1/ingest | keep | ingest_video.py, backfill.py |
| GET /api/v1/jobs | keep-thin | operational listing |
| GET /api/v1/jobs/drift | drop-confirmed | none |
| GET /api/v1/jobs/{job_id} | keep | check_job.py, job_utils.py |
| POST /api/v1/jobs/{job_id}/cancel | keep | check_job.py |
| POST /api/v1/search | keep | search.py |
| POST /api/v1/search/agentic | drop-confirmed | none |
| GET /api/v1/usage | keep-thin | LLM spend inspection |
| GET /api/v1/youtube/channel | keep | channel_videos.py |

Totals: 12 keep, 11 keep-thin, 16 drop-confirmed (of 39 operations).

## Kept-route contracts (fields consumers actually read)

### GET /health
`200` JSON with `status == "ok"` and `git_sha` (deployment gate compares the
pinned source revision). The unified service reports the Onclave release
revision here; the deployment gate is updated in the same change.

### GET /ready
`200` JSON with `status == "ready"` and `checks.postgres`, `checks.s3`,
`checks.ollama` each `"ok"` (deployment gate). The unified contract adds
broker state alongside these checks.

### POST /api/v1/ingest
Optional query `tags` (comma list, used as `?tags=test`). Body either
`{"url": "https://youtube.com/watch?v=..."}` (server detects YouTube,
fetches transcript and metadata) or a local-cache payload
`{"url", "title", "transcript_text", "transcript_format": "plain",
"metadata"}`. Response fields read: `title`, `content_id`, `content_type`,
`job_id` (job id is polled afterwards). Backfill sends the same shapes.

### GET /api/v1/content
Query params used: `content_type`, `limit` (max 100), `offset`,
`exclude_tags`, and tag filtering via the suffix built by `list_videos.py`.
Response fields read: `total`, `items[]` with `id`, `title`, `status`,
`created_at`, `chunk_count`, `tags`, and `metadata` containing `video_id`,
`published_at`, `tags`. `find_content.py` paginates with `offset` until it
matches `metadata.video_id`.

### GET /api/v1/content/{id}
`404` when missing. Fields read: `title`, `content_type`, `summary`, `tags`,
`metadata.video_id`; the `--json` mode prints the full document, and the
operator workflow expects `summary`, `tags`, `topics`, and `entities` to be
populated after the processing job completes.

### GET /api/v1/content/{id}/download
`200` with the raw stored document body (transcript text for YouTube
content). Used by `get_content.py --transcript-only`.

### POST /api/v1/content/{id}/annotations
Body: `{"text", "title", "source_type", "tags"}`. Response fields read:
`id`, `title`, `tags`. Annotations become searchable content linked to the
parent.

### POST /api/v1/content/{id}/reprocess
`404` when missing. Response fields read: `status`, `job_id`, `content_id`.

### GET /api/v1/jobs/{job_id}
`404` when missing. Response field read: `status`; terminal values are
exactly `completed`, `failed`, `cancelled` (poller in `job_utils.py` waits
for these). Non-terminal values observed: `pending`, `processing`.

### POST /api/v1/jobs/{job_id}/cancel
`404` when missing. Response field read: `status`.

### POST /api/v1/search
Body: `{"query", "limit"}`. Response fields read: `total`, `results[]` with
`snippet` plus identifying fields (title/content id) printed per result.
Semantic search over Ollama embeddings; parity check is that recorded
queries return the expected known content.

### GET /api/v1/youtube/channel
Query built by `channel_videos.py` (channel handle/id and limit). `404`
triggers client fallback to the YouTube Data API. Response fields read:
`source`, `videos[]` with `title`, `url`, `published_at`, `duration`,
`view_count`.

## Client-to-route map (all map to kept routes)

| Client | Routes |
| --- | --- |
| tools/menos-youtube/ingest_video.py | POST /api/v1/ingest |
| tools/menos-youtube/list_videos.py | GET /api/v1/content |
| tools/menos-youtube/find_content.py | GET /api/v1/content |
| tools/menos-youtube/get_content.py | GET /api/v1/content/{id}, GET /api/v1/content/{id}/download |
| tools/menos-youtube/post_annotation.py | POST /api/v1/content/{id}/annotations |
| tools/menos-youtube/reprocess.py | POST /api/v1/content/{id}/reprocess (+ job poll) |
| tools/menos-youtube/check_job.py, job_utils.py | GET /api/v1/jobs/{job_id}, POST /api/v1/jobs/{job_id}/cancel |
| tools/menos-youtube/search.py | POST /api/v1/search |
| tools/menos-youtube/channel_videos.py | GET /api/v1/youtube/channel |
| claude/hooks/menos-circuit/probe.py | GET /health |
| claude/hooks/menos-circuit/backfill.py | GET /api/v1/content/{id}, POST /api/v1/ingest |
| tools/menos-youtube/fetch_transcript.py, fetch_metadata.py | local-only, no API calls |
| deployment health gates | GET /health, GET /ready |
