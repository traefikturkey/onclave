# Menos Environment Contract

The Menos app definition contains no inventory, DNS mechanism, or
secret-provider dependency. Consumers provide immutable image references,
credentials, public authorization keys, networking, and persistent storage.

## Required images

- `MENOS_API_IMAGE`
- `SURREALDB_IMAGE`
- `MINIO_IMAGE`
- `OLLAMA_IMAGE`
- `SEARXNG_IMAGE`
- `DOCLING_IMAGE`

Production values should use `tag@sha256:digest` references.

## Required credentials

- `SURREALDB_PASSWORD`
- `S3_ACCESS_KEY`
- `S3_SECRET_KEY`
- `SEARXNG_SECRET`
- `WEBSHARE_PROXY_USERNAME`
- `WEBSHARE_PROXY_PASSWORD`
- `YOUTUBE_API_KEY`
- `OPENROUTER_API_KEY`
- `ANTHROPIC_API_KEY`

`OPENAI_API_KEY`, `CALLBACK_URL`, and `CALLBACK_SECRET` are optional.

## Public authorization keys

`MENOS_AUTHORIZED_KEYS_FILE` points to a file containing one or more public
`ssh-ed25519` authorization lines. The consumer may materialize this file from
Bitwarden, a private values repository, or another configuration provider.
Private keys never belong in the app definition.
