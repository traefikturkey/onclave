#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_HOST:?}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DATABASE:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_PASSWORD:?}"

output_dir="${1:?usage: backup-postgres.sh OUTPUT_DIR}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "${output_dir}"
dump="${output_dir}/menos-postgres-${stamp}.dump"
manifest="${dump}.manifest.json"

export PGPASSWORD="${POSTGRES_PASSWORD}"
pg_dump --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}" \
  --username="${POSTGRES_USER}" --dbname="${POSTGRES_DATABASE}" \
  --format=custom --no-owner --no-privileges --file="${dump}"
sha256="$(sha256sum "${dump}" | awk '{print $1}')"
python3 - "${manifest}" "$(basename "${dump}")" "${sha256}" "${stamp}" <<'PY'
import json
import sys
from pathlib import Path

path, dump_name, checksum, created_at = sys.argv[1:]
Path(path).write_text(
    json.dumps(
        {
            "format": "pg_dump-custom-v1",
            "dump": dump_name,
            "sha256": checksum,
            "created_at": created_at,
        },
        sort_keys=True,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
PY
sha256sum "${dump}" >"${dump}.sha256"
printf '%s\n' "${manifest}"
