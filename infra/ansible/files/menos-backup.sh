#!/bin/bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Menos backup script
# Exports SurrealDB, copies MinIO data, and creates a timestamped backup.
# Intended to run on the server (192.0.2.241) via Ansible or cron.
# ---------------------------------------------------------------------------

BACKUP_DATE="${1:-$(date +%Y-%m-%d)}"
BACKUP_ROOT="${BACKUP_PATH:-/backups/menos}"
BACKUP_DIR="${BACKUP_ROOT}/${BACKUP_DATE}"
DATA_PATH="${DATA_PATH:-/srv/menos/data}"
DEPLOY_PATH="${DEPLOY_PATH:-/srv/menos}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

log() { echo "[$(date -Iseconds)] $*"; }

die() {
    log "ERROR: $*"
    exit 1
}

# ---------------------------------------------------------------------------
# Load credentials from .env if not already set
# ---------------------------------------------------------------------------
ENV_FILE="${DEPLOY_PATH}/.env"
if [[ -f "$ENV_FILE" ]]; then
    log "Loading credentials from ${ENV_FILE}"
    # Read key=value pairs, skip comments and blank lines
    while IFS='=' read -r key value; do
        key="${key## }"
        key="${key%% }"
        [[ -z "$key" || "$key" == \#* ]] && continue
        # Only set if not already present in environment
        if [[ -z "${!key:-}" ]]; then
            export "${key}=${value}"
        fi
    done < "$ENV_FILE"
fi

# Validate required credentials
[[ -n "${SURREALDB_PASSWORD:-}" ]] || die "SURREALDB_PASSWORD is not set"

SURREALDB_NAMESPACE="${SURREALDB_NAMESPACE:-menos}"
SURREALDB_DATABASE="${SURREALDB_DATABASE:-menos}"

# ---------------------------------------------------------------------------
# Create backup directory
# ---------------------------------------------------------------------------
log "Starting backup for ${BACKUP_DATE}"
mkdir -p "${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Export SurrealDB
# ---------------------------------------------------------------------------
log "Exporting SurrealDB (namespace=${SURREALDB_NAMESPACE}, database=${SURREALDB_DATABASE})"
docker exec menos-surrealdb /surreal export \
    --endpoint http://localhost:8000 \
    --username root \
    --password "${SURREALDB_PASSWORD}" \
    --namespace "${SURREALDB_NAMESPACE}" \
    --database "${SURREALDB_DATABASE}" \
    /tmp/backup.surql || die "SurrealDB export failed"

docker cp menos-surrealdb:/tmp/backup.surql "${BACKUP_DIR}/database.surql" \
    || die "Failed to copy SurrealDB export from container"

# Note: /tmp/backup.surql inside container is overwritten on each run.
# Minimal SurrealDB image lacks rm, so we skip in-container cleanup.

SURQL_SIZE=$(stat -c%s "${BACKUP_DIR}/database.surql" 2>/dev/null || echo 0)
log "SurrealDB export complete (${SURQL_SIZE} bytes)"

# ---------------------------------------------------------------------------
# Copy MinIO data
# ---------------------------------------------------------------------------
log "Copying MinIO data from ${DATA_PATH}/minio"
if [[ -d "${DATA_PATH}/minio" ]]; then
    rsync -a --delete "${DATA_PATH}/minio/" "${BACKUP_DIR}/minio/" \
        || die "MinIO data copy failed"
    MINIO_SIZE=$(du -sb "${BACKUP_DIR}/minio" 2>/dev/null | cut -f1 || echo 0)
    log "MinIO data copy complete (${MINIO_SIZE} bytes)"
else
    log "WARNING: MinIO data directory not found at ${DATA_PATH}/minio, skipping"
    MINIO_SIZE=0
fi

# ---------------------------------------------------------------------------
# Capture container versions
# ---------------------------------------------------------------------------
SURREALDB_VERSION=$({ docker inspect menos-surrealdb --format '{{.Config.Image}}' 2>/dev/null || echo "unknown"; } | tr -d '\r\n')
MINIO_VERSION=$({ docker inspect menos-minio --format '{{.Config.Image}}' 2>/dev/null || echo "unknown"; } | tr -d '\r\n')
OLLAMA_VERSION=$({ docker inspect menos-ollama --format '{{.Config.Image}}' 2>/dev/null || echo "unknown"; } | tr -d '\r\n')
API_VERSION=$({ docker inspect menos-api --format '{{.Config.Image}}' 2>/dev/null || echo "unknown"; } | tr -d '\r\n')

# ---------------------------------------------------------------------------
# Create manifest
# ---------------------------------------------------------------------------
log "Creating backup manifest"
python3 - "${BACKUP_DIR}/manifest.json" \
    "${BACKUP_DATE}" "$(date -Iseconds)" "$(hostname)" \
    "${SURQL_SIZE}" "${SURREALDB_NAMESPACE}" "${SURREALDB_DATABASE}" \
    "${MINIO_SIZE}" "${SURREALDB_VERSION}" "${MINIO_VERSION}" \
    "${OLLAMA_VERSION}" "${API_VERSION}" <<'PY'
import json
import sys
from pathlib import Path

(
    output,
    backup_date,
    created_at,
    hostname,
    surrealdb_size,
    namespace,
    database,
    minio_size,
    surrealdb_version,
    minio_version,
    ollama_version,
    api_version,
) = sys.argv[1:]
manifest = {
    "backup_date": backup_date,
    "created_at": created_at,
    "hostname": hostname,
    "surrealdb_export": {
        "file": "database.surql",
        "size_bytes": int(surrealdb_size),
        "namespace": namespace,
        "database": database,
    },
    "minio_data": {"directory": "minio/", "size_bytes": int(minio_size)},
    "container_versions": {
        "surrealdb": surrealdb_version,
        "minio": minio_version,
        "ollama": ollama_version,
        "menos-api": api_version,
    },
}
Path(output).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
python3 -m json.tool "${BACKUP_DIR}/manifest.json" >/dev/null \
    || die "Backup manifest validation failed"

log "Manifest written to ${BACKUP_DIR}/manifest.json"

# ---------------------------------------------------------------------------
# Cleanup old backups
# ---------------------------------------------------------------------------
log "Removing backups older than ${RETENTION_DAYS} days"
DELETED=0
if [[ -d "${BACKUP_ROOT}" ]]; then
    while IFS= read -r old_dir; do
        [[ -d "$old_dir" ]] || continue
        log "Deleting old backup: ${old_dir}"
        rm -rf "$old_dir"
        DELETED=$((DELETED + 1))
    done < <(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}")
fi
log "Deleted ${DELETED} old backup(s)"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL_SIZE=$(du -sb "${BACKUP_DIR}" 2>/dev/null | cut -f1 || echo 0)
log "Backup complete: ${BACKUP_DIR} (${TOTAL_SIZE} bytes total)"
