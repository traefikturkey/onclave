# Onclave Environment Contract

The app definition is host-agnostic. Consumers provide image coordinates,
credentials, storage, networking, and DNS outside this directory.

## Required

| Key | Purpose |
| --- | --- |
| `RABBITMQ_DEFAULT_USER` | RabbitMQ application user |
| `RABBITMQ_DEFAULT_PASS` | RabbitMQ application password |
| `ONCLAVE_CORE_IMAGE_REPOSITORY` | Core image repository, without tag or digest |
| `ONCLAVE_CORE_IMAGE_TAG` | Immutable source commit tag |
| `ONCLAVE_CORE_IMAGE_DIGEST` | Image digest in `sha256:<hex>` form |

The core image is resolved as
`REPOSITORY:TAG@DIGEST`; both the source revision and registry content are
therefore explicit.

## Optional tuning

| Key | Default |
| --- | --- |
| `ONCLAVE_QUEUE_TTL_MS` | `604800000` |
| `ONCLAVE_QUEUE_MAX_LENGTH` | `1000` |
| `ONCLAVE_HEARTBEAT_STALE_MS` | `90000` |
| `ONCLAVE_MAX_EXCHANGES` | `16` |
| `ONCLAVE_MAX_TOTAL_TOKENS` | `200000` |

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
