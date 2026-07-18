# Deployment

## Docker Desktop Required

**If Docker Desktop is not running and a task requires it (deployment, Ansible, container operations):**

1. STOP immediately
2. Ask the user to start Docker Desktop
3. Do NOT attempt workarounds (direct file operations, rm -rf, manual scp, etc.)

Workarounds to deployment tooling can lead to dangerous operations on production servers. Always use the proper deployment pipeline.

## Architecture
- Ansible runs inside a Docker container (`infra/ansible/`)
- Project root mounted at `/project:ro`
- SSH keys mounted from `~/.ssh` → `/mnt/ssh:ro`
- Server: 192.168.16.241 (user: anvil), deploy path: /apps/menos

## Deploy Command
```bash
cd infra/ansible
docker compose run --rm ansible ansible-playbook -i inventory/hosts.yml playbooks/deploy.yml
```

## Version Gate
- Git SHA baked into Docker image via `--build-arg`, exposed on `/health`
- Pre-deploy: dirty tree check + ancestry check against server's current SHA
- Post-deploy: curl `/health`, assert SHA matches with retries

## Deployment Flow

1. Ansible deploys: syncs files via rsync, rebuilds containers on server
2. Container restarts: menos-api starts
3. Migrations run automatically on app startup via lifespan handler
4. Post-deploy verification: `/health` checked for SHA match

Remote stack: SurrealDB, MinIO, Ollama, menos-api containers.

## After Ansible Dockerfile Changes

Must rebuild manually: `cd infra/ansible && docker compose build --no-cache ansible`

## Smoke Tests

After deployment:
```bash
cd api
uv run pytest tests/smoke/ -m smoke -v
```
