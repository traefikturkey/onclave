"""Contract tests for PostgreSQL restore safeguards."""

from pathlib import Path

RESTORE_SCRIPT = Path(__file__).parents[4] / "deploy" / "app" / "menos" / "restore-postgres.sh"


def _script() -> str:
    return RESTORE_SCRIPT.read_text(encoding="utf-8")


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
