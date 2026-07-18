# Onclave Infrastructure

Deploys the central onclave stack (rabbitmq + onclave-core) to the docker
host with the ansible-in-docker harness adapted from the menos deployment
pattern. The harness runs in a container, so only docker is needed locally.

## Layout

- `ansible/docker-compose.yml` - the harness container (ansible + rsync +
  gitleaks) with the repo mounted at `/project`.
- `ansible/inventory/hosts.yml` - target host and deploy paths
  (`/apps/onclave` on the docker host).
- `ansible/playbooks/deploy.yml` - Infisical preflight, git cleanliness
  gate, build-context rsync, compose build/up, health verification.
- `ansible/files/onclave/docker-compose.yml` - the production stack
  definition installed on the target.
- `../scripts/onclave-infisical-env.py` - renders the runtime `.env` from
  Infisical (project `dotfiles`, environment `prod`, path `/onclave`)
  without printing secret values.

## Usage

```bash
just deploy-build     # build the harness image (first time / on change)
just deploy-syntax    # playbook syntax check, no secrets needed
just deploy-lint      # ansible-lint, no secrets needed
just deploy -- --ask-vault-pass -e @vault.yml   # real deploy
```

The deploy requires an Infisical machine identity with read access to the
`/onclave` secret path, supplied as `vault_onclave_infisical_machine_client_id`
and `vault_onclave_infisical_machine_client_secret` (see
`ansible/playbooks/group_vars/all.example.yml`). Required secrets at
`/onclave`: `RABBITMQ_DEFAULT_USER`, `RABBITMQ_DEFAULT_PASS`.

The playbook refuses to deploy a dirty working tree and verifies
`/health` reports broker connectivity after `docker compose up`.
