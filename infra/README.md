# Onclave Infrastructure

Deploys the central Onclave stack, including RabbitMQ and the content vault,
to the docker host with the ansible-in-docker harness. The harness runs in a
container, so only docker is needed locally.

## Layout

- `ansible/docker-compose.yml` - the harness container (ansible + rsync +
  gitleaks + bws) with the repo mounted at `/project`.
- `../deploy/app/onclave/` - provider-neutral unified app definition.
- `services.json` - dependency and state order for catalog commands.
- `../values/inventory/` - ignored site inventory and group variables,
  initialized from `../scaffold/`.
- `ansible/playbooks/deploy.yml` - temporary direct Onclave deployment.
- `ansible/files/onclave/docker-compose.yml` - production stack definition
  installed on the target.
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

Onclave requires broker, vault, and dependency credentials documented in
`../deploy/app/onclave/env-contract.md`.

## Usage

```bash
just values-init      # create ignored values from public-safe scaffold
just public-safety    # reject tracked site-specific values
just services         # list catalog services and deployment modes
just validate         # validate the unified app definition and the harness
just validate onclave # validate the unified app definition and the harness
just deploy-build     # build the harness image (first time / on change)
just deploy-syntax    # playbook syntax check, no secrets needed
just deploy-lint      # ansible-lint, no secrets needed
just deploy onclave   # temporary direct path; approval required
```

The deployment playbook refuses dirty working trees and verifies service
health after `docker compose up`.

The validation container stays root because it normalizes read-only SSH key
mount permissions. Repository and values mounts are read-only, and the harness
writes no generated artifacts to the host, so host UID/GID mapping would not
change file ownership outcomes.
