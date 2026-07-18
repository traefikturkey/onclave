# Onclave Infrastructure

Deploys the central onclave stack (rabbitmq + onclave-core) to the docker
host with the ansible-in-docker harness adapted from the menos deployment
pattern. The harness runs in a container, so only docker is needed locally.

## Layout

- `ansible/docker-compose.yml` - the harness container (ansible + rsync +
  gitleaks + bws) with the repo mounted at `/project`.
- `ansible/inventory/hosts.yml` - target host and deploy paths
  (`/apps/onclave` on the docker host).
- `ansible/playbooks/deploy.yml` - Bitwarden secret preflight, git
  cleanliness gate, build-context rsync, compose build/up, health
  verification.
- `ansible/files/onclave/docker-compose.yml` - the production stack
  definition installed on the target.
- `../scripts/onclave-bws-env.py` - renders the runtime `.env` from
  Bitwarden Secrets Manager via the `bws` CLI without printing secret
  values.

## Secrets

Secrets come from Bitwarden Secrets Manager through a machine account
access token. The host shell provides (loaded from
`~/.dotfiles/private/secrets.env`, passed through to the harness):

- `BITWARDEN_ACCESS_KEY` - machine account access token
- `BITWARDEN_API_SERVER` / `BITWARDEN_IDENTITY_SERVER` - server URLs
- `ONCLAVE_BWS_PROJECT_ID` - optional project scope

Required secrets by key name (any project the machine account can read):
`RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS` (min 12 chars; placeholder
values are rejected).

## Usage

```bash
just deploy-build     # build the harness image (first time / on change)
just deploy-syntax    # playbook syntax check, no secrets needed
just deploy-lint      # ansible-lint, no secrets needed
just deploy           # real deploy (non-interactive)
```

The playbook refuses to deploy a dirty working tree and verifies
`/health` reports broker connectivity after `docker compose up`.
