#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  : "${CONTAINER_RUNTIME:?required when POSTGRES_CONTAINER is set}"
else
  : "${ONCLAVE_VAULT_POSTGRES_HOST:?}"
  : "${ONCLAVE_VAULT_POSTGRES_PORT:=5432}"
  : "${ONCLAVE_VAULT_POSTGRES_DATABASE:?}"
  : "${ONCLAVE_VAULT_POSTGRES_USER:?}"
  : "${ONCLAVE_VAULT_POSTGRES_PASSWORD:?}"
fi

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
if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  table_count="$(
    # shellcheck disable=SC2016 # Expand database credentials inside the container.
    "${CONTAINER_RUNTIME}" exec "${POSTGRES_CONTAINER}" sh -ceu '
      : "${POSTGRES_DB:?}"
      : "${POSTGRES_USER:?}"
      : "${POSTGRES_PASSWORD:?}"
      PGPASSWORD="${POSTGRES_PASSWORD}" exec psql \
        --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
        --no-psqlrc --tuples-only --no-align --command \
        "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = '\''public'\''"
    '
  )"
else
  export PGPASSWORD="${ONCLAVE_VAULT_POSTGRES_PASSWORD}"
  table_count="$(
    psql --host="${ONCLAVE_VAULT_POSTGRES_HOST}" --port="${ONCLAVE_VAULT_POSTGRES_PORT}" \
      --username="${ONCLAVE_VAULT_POSTGRES_USER}" --dbname="${ONCLAVE_VAULT_POSTGRES_DATABASE}" \
      --no-psqlrc --tuples-only --no-align --command \
      "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'"
  )"
fi
[[ "${table_count}" == "0" ]] || {
  printf 'Restore target must have an empty public schema\n' >&2
  exit 1
}
if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  # shellcheck disable=SC2016 # Expand database credentials inside the container.
  "${CONTAINER_RUNTIME}" exec -i "${POSTGRES_CONTAINER}" sh -ceu '
    : "${POSTGRES_DB:?}"
    : "${POSTGRES_USER:?}"
    : "${POSTGRES_PASSWORD:?}"
    PGPASSWORD="${POSTGRES_PASSWORD}" exec pg_restore \
      --username="${POSTGRES_USER}" --dbname="${POSTGRES_DB}" \
      --exit-on-error --single-transaction --no-owner --no-privileges
  ' <"${dump}"
else
  pg_restore --host="${ONCLAVE_VAULT_POSTGRES_HOST}" --port="${ONCLAVE_VAULT_POSTGRES_PORT}" \
    --username="${ONCLAVE_VAULT_POSTGRES_USER}" --dbname="${ONCLAVE_VAULT_POSTGRES_DATABASE}" \
    --exit-on-error --single-transaction --no-owner --no-privileges "${dump}"
fi
