#!/usr/bin/env bash
set -euo pipefail

: "${POSTGRES_HOST:?}"
: "${POSTGRES_PORT:=5432}"
: "${POSTGRES_DATABASE:?}"
: "${POSTGRES_USER:?}"
: "${POSTGRES_PASSWORD:?}"

dump="${1:?usage: restore-postgres.sh DUMP_FILE}"
checksum_file="${dump}.sha256"
manifest="${dump}.manifest.json"
[[ -f "${dump}" && -f "${checksum_file}" && -f "${manifest}" ]] || {
  printf 'Dump, checksum, or manifest is missing\n' >&2
  exit 1
}
(
  cd "$(dirname "${dump}")"
  sha256sum -c "$(basename "${checksum_file}")"
)
python3 - "${manifest}" "$(basename "${dump}")" "${checksum_file}" <<'PY'
import json
import sys
from pathlib import Path

manifest_path, dump_name, checksum_path = sys.argv[1:]
manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
checksum = Path(checksum_path).read_text(encoding="utf-8").split()[0]
if manifest.get("format") != "pg_dump-custom-v1":
    raise SystemExit("Unsupported backup format")
if manifest.get("dump") != dump_name or manifest.get("sha256") != checksum:
    raise SystemExit("Backup manifest does not match dump")
PY
export PGPASSWORD="${POSTGRES_PASSWORD}"
table_count="$(
  psql --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}" \
    --username="${POSTGRES_USER}" --dbname="${POSTGRES_DATABASE}" \
    --no-psqlrc --tuples-only --no-align --command \
    "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
)"
[[ "${table_count}" == "0" ]] || {
  printf 'Restore target must have an empty public schema\n' >&2
  exit 1
}
pg_restore --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}" \
  --username="${POSTGRES_USER}" --dbname="${POSTGRES_DATABASE}" \
  --exit-on-error --single-transaction --no-owner --no-privileges "${dump}"
