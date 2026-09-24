# Onclave App Definition

This directory defines the portable Onclave stack. A single `onclave-core`
container serves broker RPC and the authenticated content vault API. RabbitMQ,
PostgreSQL, MinIO, Ollama, SearXNG, and Docling Serve are its dependencies.

## Validate

```bash
docker compose \
  --env-file deploy/app/onclave/.env.example \
  -f deploy/app/onclave/compose.yaml \
  config --quiet
```

## Build from source

The production compose requires an immutable registry image. For local image
validation, layer on the build override:

```bash
docker compose \
  --env-file deploy/app/onclave/.env.example \
  -f deploy/app/onclave/compose.yaml \
  -f deploy/app/onclave/compose.build.yaml \
  build onclave-core
```

## Health and ports

- The core is published as `8000:8000`. `GET /live` is process-only and
  returns HTTP 200 with `status: "ok"` independently of external dependencies;
  the container healthcheck uses it. `GET /health` remains diagnostic, with
  `status: "ok"` or `"degraded"`, broker and `git_sha` fields, and safe
  transcript diagnostics. A transient transcript outage may return HTTP 503;
  this endpoint is not the container restart probe. Transcript diagnostics
  include `recentFailures` (maximum 10) and the static `transcript.proxy`
  accessor, which exposes only `{mode, configured, credentialStatus,
  dispatcherStatus, connectivity: "not_checked"}`. No proxy URL or credentials
  are exposed, and this is not proof of connectivity.
- `GET /ready` returns HTTP 200 with `ready` or HTTP 503 with `degraded`. It
  checks PostgreSQL, S3, the configured embedding provider, and the enabled
  unified-pipeline provider unless configured as `none`. Unused Ollama is
  reported as `skipped`. Provider checks are non-generative and bounded to 5
  seconds; cloud auth probes are cached/coalesced for 5 seconds. They report
  only safe result tokens.
  `GET /metrics` returns Prometheus text with content type
  `text/plain; version=0.0.4; charset=utf-8`. It exposes six counters and four
  duration summaries; metric family names and labels are listed in
  [`env-contract.md`](env-contract.md#prometheus-metric-families). Families
  include `HELP` and `TYPE` before samples; in-memory values reset on restart.
- RabbitMQ remains published on `5672`; its existing management port remains
  published on `15672`.
- MinIO is published on `9000` and `9001`, Ollama on `11434`, SearXNG as
  `8888:8080`, and Docling Serve on `5001`.
- PostgreSQL remains internal on port `5432`.

A fresh PostgreSQL volume receives `vault-schema.sql` through the image
entrypoint. Existing volumes receive additive, idempotent vault migrations
(including `20260722_job_durability`) automatically during vault construction,
before requests are served; this does not rely on PostgreSQL init scripts being
rerun. The first rollout consuming this migration must use the reviewed
operator deployment role, not a core-only helper. The named volumes are
`rabbitmq-data`, `onclave-data`, `postgres-data`,
`minio-data`, and `ollama-data`.

Pending jobs and expired processing leases recover after restart. A legacy
active job without saved input fails explicitly with
`JOB_RECOVERY_PAYLOAD_MISSING`. Callback delivery is at-least-once, with stable
`Idempotency-Key: job:<id>:callback:v1` and retry backoff from 1 second up to
15 minutes. Authenticated `GET /api/v1/jobs/{job_id}/deliveries` exposes
callback delivery status independently from job status. An unknown job ID
returns 404; a known job without delivery intents returns 200 with an empty
result. Retries are automatic; there is no manual delivery endpoint.

## Authorization and smoke gate

`ONCLAVE_AUTHORIZED_KEYS_FILE` supplies the read-only
`/keys/authorized_keys` file used by vault request signatures. Run
`./deploy/app/onclave/smoke.sh` as an operator gate. It uses a temporary
throwaway Ed25519 key, validates health, readiness, and signed `whoami`, then
removes its Compose project and volumes.

## PostgreSQL backups

Use `backup-postgres.sh` for credential-safe custom-format logical dumps and
`restore-postgres.sh` for validated restores into an empty database. For an
internal Compose database, set `POSTGRES_CONTAINER=onclave-postgres` and
`CONTAINER_RUNTIME=docker` or `podman`. The helpers otherwise use
`ONCLAVE_VAULT_POSTGRES_HOST`, `ONCLAVE_VAULT_POSTGRES_PORT`,
`ONCLAVE_VAULT_POSTGRES_DATABASE`, `ONCLAVE_VAULT_POSTGRES_USER`, and
`ONCLAVE_VAULT_POSTGRES_PASSWORD` directly.
