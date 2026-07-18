# Troubleshooting

## Server Access

```bash
ssh -i ~/.ssh/id_ed25519 anvil@192.168.16.241
```

## Viewing Logs

```bash
docker logs menos-api -f            # API logs (follow)
docker compose logs -f               # All containers
docker compose logs -f surrealdb     # Specific service
```

## Container Status

```bash
docker compose ps                    # Check all
docker compose restart menos-api     # Restart service
docker compose up -d --build menos-api  # Full rebuild
```

## Health Checks

```bash
curl http://192.168.16.241:8000/health   # Basic (returns git SHA)
curl http://192.168.16.241:8000/ready    # Readiness (checks SurrealDB + MinIO + Ollama)
```

## Authenticated API Testing

```bash
cd api
uv run python scripts/signed_request.py GET /api/v1/content?content_type=youtube
```

## Common Issues

### NVIDIA Driver Mismatch
After kernel updates, NVIDIA driver may fail to load. Symptoms: Ollama crashes, embedding generation fails.
```bash
nvidia-smi          # Check driver status
make reboot         # Fix: reboot the server
```

### Useful Ansible Commands
```bash
make shell          # Interactive shell in Ansible container
make deploy         # Full deploy (sync, rebuild, restart)
make update         # Quick update (pull images, restart)
make backup         # Backup server config
```
