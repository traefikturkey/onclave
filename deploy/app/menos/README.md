# Menos App Definition

This directory defines the portable Menos application stack. It carries no DNS
labels or site-specific host values.

Validate the tracked example contract:

```bash
docker compose \
  --env-file deploy/app/menos/.env.example \
  -f deploy/app/menos/compose.yaml \
  config --quiet
```

## Health contract

- `GET /health` on the API port returns HTTP 200 and the deployed source SHA.
- `GET /ready` reports PostgreSQL, S3-compatible storage, and Ollama status.
- Authenticated smoke coverage must verify content access, ingest, list, and
  semantic search before cutover.

The PostgreSQL port remains internal to the Compose network. The consumer owns
DNS, TLS, host placement, persistent-volume implementation, secret rendering,
public-key materialization, and backup integration. Use `backup-postgres.sh`
for credential-safe custom-format logical dumps and `restore-postgres.sh` for
validated restores into an empty database.

## PostgreSQL backup modes

The helpers preserve direct client access for deployments that expose
PostgreSQL to the backup host. Set `POSTGRES_HOST`, `POSTGRES_PORT`,
`POSTGRES_DATABASE`, `POSTGRES_USER`, and `POSTGRES_PASSWORD` before running
either helper.

For rootless Podman or Compose deployments where PostgreSQL remains internal,
set only these host-side routing values:

- `POSTGRES_CONTAINER`: the existing PostgreSQL container name or ID.
- `CONTAINER_RUNTIME`: the container CLI executable, such as `podman` or
  `docker`.

Container mode runs `pg_dump`, `psql`, and `pg_restore` inside that container.
The container must provide `POSTGRES_DB`, `POSTGRES_USER`, and
`POSTGRES_PASSWORD` in its environment. Do not export those credentials to the
host helper. Dumps, manifests, and checksums remain host files. Restore still
refuses a target whose `public` schema contains tables.

```bash
POSTGRES_CONTAINER=menos-postgres \
CONTAINER_RUNTIME=podman \
./backup-postgres.sh /var/backups/menos

POSTGRES_CONTAINER=menos-postgres \
CONTAINER_RUNTIME=podman \
./restore-postgres.sh /var/backups/menos/menos-postgres-STAMP.dump
```
