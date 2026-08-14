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

- `GET /health` and `GET /ready` are published as `8000:8000`.
- RabbitMQ remains published on `5672`; its existing management port remains
  published on `15672`.
- MinIO is published on `9000` and `9001`, Ollama on `11434`, SearXNG as
  `8888:8080`, and Docling Serve on `5001`.
- PostgreSQL remains internal on port `5432`.

A fresh PostgreSQL volume receives `vault-schema.sql` through the image entrypoint.
Existing PostgreSQL data remains untouched. The named volumes are
`rabbitmq-data`, `onclave-data`, `postgres-data`, `minio-data`, and
`ollama-data`.

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
