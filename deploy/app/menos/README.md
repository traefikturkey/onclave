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
- `GET /ready` reports SurrealDB, S3-compatible storage, and Ollama status.
- Authenticated smoke coverage must verify content access, ingest, list, and
  semantic search before cutover.

The consumer owns DNS, TLS, host placement, persistent-volume implementation,
secret rendering, public-key materialization, and backup integration.
