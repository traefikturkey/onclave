# Onclave Infrastructure

Deploys the central onclave stack (rabbitmq + onclave-core) to the docker
host with the ansible-in-docker harness adapted from the menos deployment
pattern. The harness runs in a container, so only docker is needed locally.

## Layout

- `ansible/docker-compose.yml` - the harness container (ansible + rsync +
  gitleaks + bws) with the repo mounted at `/project`.
- `../deploy/app/onclave/` - provider-neutral Onclave app definition.
- `../values/inventory/` - ignored site inventory and group variables,
  initialized from `../scaffold/`.
- `ansible/playbooks/deploy.yml` - temporary direct Onclave deployment.
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

The non-secret project ID and server URLs live in the private values
repository under `values/inventory/group_vars/all.yml`.

Onclave requires `RABBITMQ_DEFAULT_USER` and `RABBITMQ_DEFAULT_PASS`.
Menos requires `SURREALDB_PASSWORD`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`,
`SEARXNG_SECRET`, Webshare credentials, and the YouTube, OpenRouter, and
Anthropic API keys. The renderer also emits temporary `MINIO_*` aliases so
that the pre-absorption Compose file remains restart-safe until cutover.

## Usage

```bash
just values-init      # create ignored values from public-safe scaffold
just public-safety    # reject tracked site-specific values
just deploy-build     # build the harness image (first time / on change)
just deploy-syntax    # playbook syntax check, no secrets needed
just deploy-lint      # ansible-lint, no secrets needed
just deploy           # temporary direct path; approval required
```

The deployment playbook refuses dirty working trees and verifies service
health after `docker compose up`. Menos deployment follows
`docs/infra-alignment-plan.md`; its direct legacy playbook remains reference
material only.
