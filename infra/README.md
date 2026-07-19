# Onclave Infrastructure

Deploys the central onclave stack (rabbitmq + onclave-core) to the docker
host with the ansible-in-docker harness adapted from the menos deployment
pattern. The harness runs in a container, so only docker is needed locally.

## Layout

- `ansible/docker-compose.yml` - the harness container (ansible + rsync +
  gitleaks + bws) with the repo mounted at `/project`.
- `ansible/inventory/hosts.yml` - target hosts and deploy paths for
  `/apps/onclave` and `/apps/menos`.
- `ansible/playbooks/deploy.yml` - Onclave deployment.
- `ansible/playbooks/deploy-menos.yml` - Menos deployment and secret migration.
- `ansible/files/{onclave,menos}/docker-compose.yml` - production stack
  definitions installed on the target.
- `../scripts/onclave-bws-env.py` - renders stack-specific runtime `.env`
  files from Bitwarden Secrets Manager without printing secret values.

## Secrets

Secrets come from Bitwarden Secrets Manager through a machine account
access token. The host shell provides (loaded from
`~/.dotfiles/private/secrets.env`, passed through to the harness):

- `BITWARDEN_ACCESS_KEY` - machine account access token
- `BITWARDEN_API_SERVER` / `BITWARDEN_IDENTITY_SERVER` - server URLs

The non-secret project ID is configured as `bws_project_id` in
`ansible/playbooks/group_vars/all.yml`.

Onclave requires `RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS`.
Menos requires `SURREALDB_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`SEARXNG_SECRET`, Webshare credentials, and the YouTube, OpenRouter, and
Anthropic API keys. The renderer also emits temporary `MINIO_*` aliases so
that the pre-absorption Compose file remains restart-safe until cutover.

## Usage

```bash
just deploy-build     # build the harness image (first time / on change)
just deploy-syntax    # playbook syntax check, no secrets needed
just deploy-lint      # ansible-lint, no secrets needed
just deploy           # deploy Onclave
just menos-deploy     # deploy Menos
just menos-secrets    # render and install only the Menos runtime env
just menos-deploy-syntax
just menos-deploy-lint
```

The full deployment playbooks refuse dirty working trees and verify their
service health after `docker compose up`. Secret-only Menos migration backs
up the existing runtime env before installing the Bitwarden-rendered file.
