"""Contract tests for PostgreSQL backup and restore safeguards."""

import hashlib
import json
import os
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).parents[4] / "deploy" / "app" / "menos"
BACKUP_SCRIPT = SCRIPT_DIR / "backup-postgres.sh"
RESTORE_SCRIPT = SCRIPT_DIR / "restore-postgres.sh"


def _script(path: Path = RESTORE_SCRIPT) -> str:
    return path.read_text(encoding="utf-8")


def _bash_path(path: Path) -> str:
    resolved = path.resolve().as_posix()
    if len(resolved) <= 2 or resolved[1:3] != ":/":
        return resolved
    drive_path = f"/{resolved[0].lower()}{resolved[2:]}"
    uses_wsl_mounts = subprocess.run(["bash", "-lc", "test -d /mnt/c"], check=False).returncode == 0
    return f"/mnt{drive_path}" if uses_wsl_mounts else drive_path


def _container_env(tmp_path: Path, table_count: int = 0) -> tuple[dict[str, str], Path]:
    runtime = tmp_path / "container-runtime"
    runtime.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\0' "$@" >>"${RUNTIME_ARGV_LOG}"
command_text="${!#}"
if [[ "${command_text}" == *"pg_dump"* ]]; then
  printf 'custom-dump'
elif [[ "${command_text}" == *"psql"* ]]; then
  printf '%s\\n' "${FAKE_TABLE_COUNT}"
elif [[ "${command_text}" == *"pg_restore"* ]]; then
  cat >/dev/null
fi
""",
        encoding="utf-8",
        newline="\n",
    )
    runtime.chmod(0o755)
    log = tmp_path / "runtime-argv"
    env = os.environ.copy()
    for name in (
        "POSTGRES_HOST",
        "POSTGRES_PORT",
        "POSTGRES_DATABASE",
        "POSTGRES_USER",
        "POSTGRES_PASSWORD",
    ):
        env.pop(name, None)
    env.update(
        {
            "POSTGRES_CONTAINER": "menos-postgres",
            "CONTAINER_RUNTIME": _bash_path(runtime),
            "RUNTIME_ARGV_LOG": _bash_path(log),
            "FAKE_TABLE_COUNT": str(table_count),
        }
    )
    if _bash_path(tmp_path).startswith("/mnt/"):
        forwarded = (
            "POSTGRES_CONTAINER:CONTAINER_RUNTIME:RUNTIME_ARGV_LOG:"
            "FAKE_TABLE_COUNT:POSTGRES_PASSWORD"
        )
        env["WSLENV"] = ":".join(filter(None, (env.get("WSLENV"), forwarded)))
    return env, log


def _write_backup_set(tmp_path: Path) -> Path:
    dump = tmp_path / "menos.dump"
    dump.write_bytes(b"custom-dump")
    checksum = hashlib.sha256(dump.read_bytes()).hexdigest()
    dump.with_suffix(".dump.sha256").write_text(f"{checksum}  {dump.name}\n", encoding="utf-8")
    dump.with_suffix(".dump.manifest.json").write_text(
        json.dumps({"format": "pg_dump-custom-v1", "dump": dump.name, "sha256": checksum}),
        encoding="utf-8",
    )
    return dump


def test_direct_mode_preserves_host_client_commands():
    backup = _script(BACKUP_SCRIPT)
    restore = _script()

    assert 'pg_dump --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}"' in backup
    assert '--username="${POSTGRES_USER}" --dbname="${POSTGRES_DATABASE}"' in backup
    assert 'psql --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}"' in restore
    assert 'pg_restore --host="${POSTGRES_HOST}" --port="${POSTGRES_PORT}"' in restore


def test_manifest_and_checksum_validation_precede_database_access():
    script = _script()

    assert 'manifest="${dump}.manifest.json"' in script
    assert 'sha256sum -c "$(basename "${checksum_file}")"' in script
    assert 'manifest.get("format") != "pg_dump-custom-v1"' in script
    assert 'manifest.get("dump") != dump_name' in script
    assert 'manifest.get("sha256") != checksum' in script
    assert script.index("sha256sum -c") < script.index("python3 -") < script.index("psql --host")


def test_empty_target_guard_precedes_restore():
    script = _script()

    assert "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public'" in script
    assert '[[ "${table_count}" == "0" ]]' in script
    assert "Restore target must have an empty public schema" in script
    assert script.index('[[ "${table_count}" == "0" ]]') < script.index("pg_restore --host")


def test_container_backup_keeps_secret_out_of_host_argv(tmp_path):
    env, log = _container_env(tmp_path)
    env["POSTGRES_PASSWORD"] = "replace-with-secret"
    output_dir = tmp_path / "backups"

    result = subprocess.run(
        ["bash", _bash_path(BACKUP_SCRIPT), _bash_path(output_dir)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert len(list(output_dir.glob("*.dump"))) == 1
    argv = log.read_bytes()
    assert b"pg_dump" in argv
    assert b"POSTGRES_PASSWORD" in argv
    assert b"replace-with-secret" not in argv
    assert b"--env" not in argv


def test_container_restore_enforces_empty_target_before_restore(tmp_path):
    dump = _write_backup_set(tmp_path)
    env, log = _container_env(tmp_path, table_count=1)

    result = subprocess.run(
        ["bash", _bash_path(RESTORE_SCRIPT), _bash_path(dump)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode != 0
    assert "Restore target must have an empty public schema" in result.stderr
    argv = log.read_bytes()
    assert b"psql" in argv
    assert b"pg_restore" not in argv


def test_container_restore_streams_dump_without_host_credentials(tmp_path):
    dump = _write_backup_set(tmp_path)
    env, log = _container_env(tmp_path)

    result = subprocess.run(
        ["bash", _bash_path(RESTORE_SCRIPT), _bash_path(dump)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    argv = log.read_bytes()
    assert b"psql" in argv
    assert b"pg_restore" in argv
    assert b"--env" not in argv
