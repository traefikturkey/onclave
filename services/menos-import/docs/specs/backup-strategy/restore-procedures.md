# Restore Procedures

Restore procedures for the menos backup system. Backups are stored at `/backups/menos/YYYY-MM-DD/` on the server.

## List Available Backups

```bash
# SSH to server
ssh anvil@192.168.16.241

# List all backups with dates and sizes
ls -lh /backups/menos/

# View a specific backup's manifest
cat /backups/menos/2026-02-12/manifest.json

# Find the most recent backup
ls -t /backups/menos/ | head -1
```

## Restore SurrealDB Database

### Full Database Restore

This replaces the entire database with the backup contents.

```bash
# 1. Stop the API to prevent writes during restore
cd /apps/menos
sudo docker compose stop menos-api

# 2. Import the backup into SurrealDB
#    The container must be running for this.
sudo docker cp /backups/menos/YYYY-MM-DD/database.surql menos-surrealdb:/tmp/restore.surql

sudo docker exec menos-surrealdb surreal import \
    --endpoint http://localhost:8000 \
    --username root \
    --password "${SURREALDB_PASSWORD}" \
    --namespace menos \
    --database menos \
    /tmp/restore.surql

# 3. Clean up temp file
sudo docker exec menos-surrealdb rm -f /tmp/restore.surql

# 4. Restart the API
sudo docker compose start menos-api
```

### Verify SurrealDB Restore

```bash
# Check record counts via the API
curl http://192.168.16.241:8000/health
curl http://192.168.16.241:8000/ready

# Query record counts directly
sudo docker exec menos-surrealdb surreal sql \
    --endpoint http://localhost:8000 \
    --username root \
    --password "${SURREALDB_PASSWORD}" \
    --namespace menos \
    --database menos \
    --pretty \
    "SELECT count() FROM content GROUP ALL; SELECT count() FROM chunk GROUP ALL;"
```

## Restore MinIO Data

### Full MinIO Restore

This replaces all MinIO data with the backup contents.

```bash
# 1. Stop the API and MinIO
cd /apps/menos
sudo docker compose stop menos-api minio

# 2. Replace MinIO data directory with backup
sudo rsync -a --delete /backups/menos/YYYY-MM-DD/minio/ /apps/menos/data/minio/

# 3. Restart MinIO and API
sudo docker compose start minio
sleep 5
sudo docker compose start menos-api
```

### Selective MinIO Restore

To restore specific files without replacing everything:

```bash
# Copy specific bucket contents back
sudo rsync -a /backups/menos/YYYY-MM-DD/minio/.minio.sys/ /apps/menos/data/minio/.minio.sys/
sudo rsync -a /backups/menos/YYYY-MM-DD/minio/menos/ /apps/menos/data/minio/menos/
```

## Verify Restore Success

After any restore, run these checks:

```bash
# 1. Check all services are running
cd /apps/menos
sudo docker compose ps

# 2. Health and readiness checks
curl http://192.168.16.241:8000/health
curl http://192.168.16.241:8000/ready

# 3. Run smoke tests from your local machine
cd api
uv run pytest tests/smoke/ -m smoke -v

# 4. Spot-check content via API
uv run python scripts/signed_request.py GET /api/v1/content?limit=5
```

## Recovery Scenarios

### Full Disaster Recovery

Complete server rebuild from backups. Assumes a fresh server with Docker installed.

1. Deploy the menos stack using Ansible:
   ```bash
   make deploy
   ```
2. Wait for services to start, then stop the API:
   ```bash
   ssh anvil@192.168.16.241 "cd /apps/menos && sudo docker compose stop menos-api"
   ```
3. Copy backup data to the server (from an offsite copy if server storage was lost):
   ```bash
   scp -r /path/to/offsite/YYYY-MM-DD/ anvil@192.168.16.241:/backups/menos/YYYY-MM-DD/
   ```
4. Restore SurrealDB and MinIO using the procedures above.
5. Restart the API and verify:
   ```bash
   ssh anvil@192.168.16.241 "cd /apps/menos && sudo docker compose start menos-api"
   cd api && uv run pytest tests/smoke/ -m smoke -v
   ```

### Selective Content Restore

To restore specific content items without a full database restore, query the backup file directly:

```bash
# Extract specific records from the SurrealQL export
grep "content:VIDEO_ID" /backups/menos/YYYY-MM-DD/database.surql
```

Then manually re-insert the extracted records through the API or direct SurrealDB query.

### Rollback After Failed Deploy

If a deployment breaks the database schema or data:

1. Stop the API:
   ```bash
   ssh anvil@192.168.16.241 "cd /apps/menos && sudo docker compose stop menos-api"
   ```
2. Restore from the most recent pre-deploy backup:
   ```bash
   LATEST=$(ssh anvil@192.168.16.241 "ls -t /backups/menos/ | head -1")
   ```
3. Follow the SurrealDB restore procedure using that backup date.
4. Redeploy the previous known-good version via Ansible, or start the API with the current image:
   ```bash
   ssh anvil@192.168.16.241 "cd /apps/menos && sudo docker compose start menos-api"
   ```
