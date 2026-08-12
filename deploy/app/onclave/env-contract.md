# Onclave Environment Contract

This app definition runs the Onclave broker and content vault in one core
service. Consumers provide immutable image references, credentials, public
authorization keys, networking, and persistent storage.

## Required images and keys

| Key | Purpose |
| --- | --- |
| `ONCLAVE_CORE_IMAGE_REPOSITORY` | Core image repository, without tag or digest |
| `ONCLAVE_CORE_IMAGE_TAG` | Immutable source commit tag |
| `ONCLAVE_CORE_IMAGE_DIGEST` | Core image digest in `sha256:<hex>` form |
| `POSTGRES_IMAGE` | PostgreSQL with pgvector image |
| `MINIO_IMAGE` | S3-compatible storage image |
| `OLLAMA_IMAGE` | Ollama image |
| `SEARXNG_IMAGE` | SearXNG image |
| `DOCLING_IMAGE` | Docling Serve image |
| `ONCLAVE_AUTHORIZED_KEYS_FILE` | File with one or more `ssh-ed25519` authorization lines |

The core image is resolved as `REPOSITORY:TAG@DIGEST`. Production image
values should use immutable `tag@sha256:digest` references.

## Required credentials

| Key | Purpose |
| --- | --- |
| `RABBITMQ_DEFAULT_USER` | RabbitMQ application user |
| `RABBITMQ_DEFAULT_PASS` | RabbitMQ application password |
| `POSTGRES_PASSWORD` | PostgreSQL and vault password |
| `S3_ACCESS_KEY` | MinIO root user and vault access key |
| `S3_SECRET_KEY` | MinIO root password and vault secret key |
| `SEARXNG_SECRET` | SearXNG secret |
| `WEBSHARE_PROXY_USERNAME` | Webshare proxy user |
| `WEBSHARE_PROXY_PASSWORD` | Webshare proxy password |

The Compose definition passes the Webshare values as
`ONCLAVE_VAULT_WEBSHARE_PROXY_USERNAME` and
`ONCLAVE_VAULT_WEBSHARE_PROXY_PASSWORD` to the core.

## Vault provider and callback values

| Key | Default | Purpose |
| --- | --- | --- |
| `YOUTUBE_API_KEY` | empty | YouTube metadata API key |
| `OPENAI_API_KEY` | empty | OpenAI provider key |
| `ANTHROPIC_API_KEY` | empty | Anthropic provider key |
| `OPENROUTER_API_KEY` | empty | OpenRouter provider key |
| `CALLBACK_URL` | empty | Pipeline callback URL |
| `CALLBACK_SECRET` | empty | Pipeline callback secret |
| `SEMANTIC_SCHOLAR_API_KEY` | empty | Semantic Scholar API key |

Set the key required by each selected LLM provider. The default expansion,
synthesis, and unified pipeline provider is `openrouter`. The Compose
definition passes these values to the core as
`ONCLAVE_VAULT_YOUTUBE_API_KEY`, `ONCLAVE_VAULT_OPENAI_API_KEY`,
`ONCLAVE_VAULT_ANTHROPIC_API_KEY`, `ONCLAVE_VAULT_OPENROUTER_API_KEY`,
`ONCLAVE_VAULT_CALLBACK_URL`, `ONCLAVE_VAULT_CALLBACK_SECRET`, and
`ONCLAVE_VAULT_SEMANTIC_SCHOLAR_API_KEY`.

## Core tuning

| Key | Default |
| --- | --- |
| `ONCLAVE_DATA_DIR` | `/data` |
| `ONCLAVE_QUEUE_TTL_MS` | `604800000` |
| `ONCLAVE_QUEUE_MAX_LENGTH` | `1000` |
| `ONCLAVE_HEARTBEAT_STALE_MS` | `90000` |
| `ONCLAVE_MAX_EXCHANGES` | `16` |
| `ONCLAVE_MAX_TOTAL_TOKENS` | `200000` |

`ONCLAVE_AMQP_URL` and `ONCLAVE_HTTP_PORT` are consumed by the core, but this
Compose definition supplies them as `rabbitmq` and `8000` respectively.

## Vault tuning

These variables are consumed by `services/core/src/vault/config.ts`. The
Compose definition supplies the internal dependency addresses and key path;
all remaining values can be overridden by the consumer.

| Key | Default |
| --- | --- |
| `ONCLAVE_VAULT_API_BASE_URL` | `http://localhost:8000` |
| `ONCLAVE_VAULT_POSTGRES_POOL_MIN_SIZE` | `1` |
| `ONCLAVE_VAULT_POSTGRES_POOL_MAX_SIZE` | `10` |
| `ONCLAVE_VAULT_S3_SECURE` | `false` |
| `ONCLAVE_VAULT_S3_BUCKET` | `menos` |
| `ONCLAVE_VAULT_S3_REGION` | `us-east-1` |
| `ONCLAVE_VAULT_OLLAMA_MODEL` | `mxbai-embed-large` |
| `ONCLAVE_VAULT_AGENT_EXPANSION_PROVIDER` | `openrouter` |
| `ONCLAVE_VAULT_AGENT_EXPANSION_MODEL` | empty |
| `ONCLAVE_VAULT_AGENT_RERANK_PROVIDER` | `none` |
| `ONCLAVE_VAULT_AGENT_RERANK_MODEL` | `cross-encoder/ms-marco-MiniLM-L-12-v2` |
| `ONCLAVE_VAULT_AGENT_SYNTHESIS_PROVIDER` | `openrouter` |
| `ONCLAVE_VAULT_AGENT_SYNTHESIS_MODEL` | empty |
| `ONCLAVE_VAULT_UNIFIED_PIPELINE_ENABLED` | `true` |
| `ONCLAVE_VAULT_UNIFIED_PIPELINE_PROVIDER` | `openrouter` |
| `ONCLAVE_VAULT_UNIFIED_PIPELINE_MODEL` | empty |
| `ONCLAVE_VAULT_UNIFIED_PIPELINE_MAX_CONCURRENCY` | `4` |
| `ONCLAVE_VAULT_UNIFIED_PIPELINE_MAX_NEW_TAGS` | `3` |
| `ONCLAVE_VAULT_ENTITY_MAX_TOPICS_PER_CONTENT` | `7` |
| `ONCLAVE_VAULT_ENTITY_MIN_CONFIDENCE` | `0.6` |
| `ONCLAVE_VAULT_ENTITY_FETCH_EXTERNAL_METADATA` | `true` |

The Compose definition also sets these fixed vault addresses:
`ONCLAVE_VAULT_POSTGRES_HOST`, `ONCLAVE_VAULT_POSTGRES_PORT`,
`ONCLAVE_VAULT_POSTGRES_USER`, `ONCLAVE_VAULT_POSTGRES_PASSWORD`,
`ONCLAVE_VAULT_POSTGRES_DATABASE`, `ONCLAVE_VAULT_S3_ENDPOINT_URL`,
`ONCLAVE_VAULT_S3_ACCESS_KEY`, `ONCLAVE_VAULT_S3_SECRET_KEY`,
`ONCLAVE_VAULT_OLLAMA_URL`, `ONCLAVE_VAULT_DOCLING_URL`, and
`ONCLAVE_VAULT_SSH_PUBLIC_KEYS_PATH`.

SearXNG remains a stack dependency and receives `SEARXNG_SECRET`. The current
vault configuration has no SearXNG URL variable.

## Legacy fallbacks

For every vault setting named `ONCLAVE_VAULT_<NAME>`, the core accepts
`MENOS_<NAME>` and then unprefixed `<NAME>` as fallbacks. This definition uses
only `ONCLAVE_VAULT_` names. `MENOS_POSTGRES_PASSWORD` also activates vault
mode when the preferred password is absent, and `MENOS_APP_VERSION` is the
fallback for the vault pipeline version.

## Provider seam

Render the required keys from Bitwarden Secrets Manager:

```bash
python scripts/onclave-bws-env.py --stack onclave --provider bws --validate
```

Or validate and render a plain env file:

```bash
python scripts/onclave-bws-env.py \
  --stack onclave \
  --provider env \
  --env-file deploy/app/onclave/.env.example \
  --validate
```

The env-file provider performs no shell expansion. Keep secret-bearing env
files untracked.
