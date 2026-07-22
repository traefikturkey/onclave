"""Unit tests for transactional PostgreSQL migrations."""

from contextlib import nullcontext

import pytest

from menos.services.migrator import MigrationService


class _Cursor:
    def __init__(self, rows=None, error_on=None):
        self.rows = rows or []
        self.error_on = error_on
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, statement, params=None):
        self.executed.append((statement, params))
        if self.error_on and self.error_on in statement:
            raise ValueError("bad SQL")

    def fetchall(self):
        return self.rows


class _Connection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self._cursor

    def transaction(self):
        return nullcontext()


class _Database:
    def __init__(self, cursor):
        self._connection = _Connection(cursor)

    def connection(self):
        return self._connection


def _migration(directory, name, sql="SELECT 1;"):
    path = directory / f"{name}.sql"
    path.write_text(sql, encoding="utf-8")
    return path


def test_migration_files_are_filtered_and_sorted(tmp_path):
    _migration(tmp_path, "20260201-100100_second")
    _migration(tmp_path, "20260201-100000_first")
    (tmp_path / "invalid.sql").write_text("SELECT 1;", encoding="utf-8")
    service = MigrationService(_Database(_Cursor()), tmp_path)
    assert [p.stem for p in service._migration_files()] == [
        "20260201-100000_first",
        "20260201-100100_second",
    ]


@pytest.mark.parametrize("create_directory", [False, True])
def test_missing_or_empty_migration_directory_is_fatal(tmp_path, create_directory):
    directory = tmp_path / "migrations"
    if create_directory:
        directory.mkdir()
    with pytest.raises(RuntimeError, match="migration"):
        MigrationService(_Database(_Cursor()), directory)._migration_files()


def test_applied_creates_tracking_table_and_reads_names(tmp_path):
    cursor = _Cursor(rows=[{"name": "20260201-100000_initial"}])
    service = MigrationService(_Database(cursor), tmp_path)
    assert service._applied() == {"20260201-100000_initial"}
    assert "CREATE TABLE IF NOT EXISTS schema_migration" in cursor.executed[0][0]
    assert cursor.executed[1] == ("SELECT name FROM schema_migration", None)


def test_migrate_applies_pending_in_order_and_records_each(tmp_path, monkeypatch):
    _migration(tmp_path, "20260201-100100_second", "SELECT 2;")
    _migration(tmp_path, "20260201-100000_first", "SELECT 1;")
    cursor = _Cursor()
    service = MigrationService(_Database(cursor), tmp_path)
    monkeypatch.setattr(service, "_applied", lambda: set())

    assert service.migrate() == ["20260201-100000_first", "20260201-100100_second"]
    inserts = [call for call in cursor.executed if call[0].startswith("INSERT INTO")]
    assert [call[1][0] for call in inserts] == [
        "20260201-100000_first",
        "20260201-100100_second",
    ]


def test_migrate_skips_applied_files(tmp_path, monkeypatch):
    _migration(tmp_path, "20260201-100000_initial")
    service = MigrationService(_Database(_Cursor()), tmp_path)
    monkeypatch.setattr(service, "_applied", lambda: {"20260201-100000_initial"})
    assert service.migrate() == []


def test_migrate_wraps_sql_failure(tmp_path, monkeypatch):
    _migration(tmp_path, "20260201-100000_initial", "INVALID SQL;")
    service = MigrationService(_Database(_Cursor(error_on="INVALID")), tmp_path)
    monkeypatch.setattr(service, "_applied", lambda: set())
    with pytest.raises(RuntimeError, match="20260201-100000_initial failed"):
        service.migrate()


def test_status_sorts_applied_and_identifies_pending(tmp_path, monkeypatch):
    _migration(tmp_path, "20260201-100000_first")
    _migration(tmp_path, "20260201-100100_second")
    service = MigrationService(_Database(_Cursor()), tmp_path)
    monkeypatch.setattr(service, "_applied", lambda: {"20260201-100000_first"})
    assert service.status() == {
        "applied": ["20260201-100000_first"],
        "pending": ["20260201-100100_second"],
    }
