"""Unit tests for migration service."""

from unittest.mock import MagicMock

import pytest

from menos.services.migrator import MigrationService


class TestMigrationDiscovery:
    """Tests for migration discovery and ordering."""

    def test_discover_valid_migration_files(self, tmp_path):
        """Migration discovery finds .surql files matching pattern."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        # Create valid migrations
        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE test;")
        (migrations_dir / "20260201-100100_add_field.surql").write_text("DEFINE FIELD;")

        # Create invalid files (should be ignored)
        (migrations_dir / "readme.txt").write_text("not a migration")
        (migrations_dir / "invalid_name.sql").write_text("invalid")

        mock_db = MagicMock()
        migrator = MigrationService(mock_db, migrations_dir)

        pending = migrator._get_pending_migrations()
        names = [name for name, _ in pending]

        assert len(names) == 2
        assert "20260201-100000_initial" in names
        assert "20260201-100100_add_field" in names

    def test_pending_migrations_sorted_chronologically(self, tmp_path):
        """Pending migrations are sorted by timestamp prefix."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        # Create migrations out of order
        (migrations_dir / "20260201-100100_second.surql").write_text("DEFINE FIELD;")
        (migrations_dir / "20260201-100000_first.surql").write_text("DEFINE TABLE;")
        (migrations_dir / "20260201-100200_third.surql").write_text("DEFINE INDEX;")

        mock_db = MagicMock()
        migrator = MigrationService(mock_db, migrations_dir)

        pending = migrator._get_pending_migrations()
        names = [name for name, _ in pending]

        assert names == [
            "20260201-100000_first",
            "20260201-100100_second",
            "20260201-100200_third",
        ]

    def test_get_applied_migrations_empty(self, tmp_path):
        """_get_applied_migrations returns empty set when no rows."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        mock_db = MagicMock()
        mock_db.query.return_value = []

        migrator = MigrationService(mock_db, migrations_dir)
        applied = migrator._get_applied_migrations()

        assert applied == set()

    def test_get_applied_migrations_old_format(self, tmp_path):
        """_get_applied_migrations handles old SurrealDB response format."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        mock_db = MagicMock()
        mock_db.query.return_value = [
            {
                "result": [
                    {"name": "20260201-100000_initial"},
                    {"name": "20260201-100100_add_field"},
                ]
            }
        ]

        migrator = MigrationService(mock_db, migrations_dir)
        applied = migrator._get_applied_migrations()

        assert applied == {"20260201-100000_initial", "20260201-100100_add_field"}

    def test_get_applied_migrations_new_format(self, tmp_path):
        """_get_applied_migrations handles new SurrealDB response format."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        mock_db = MagicMock()
        mock_db.query.return_value = [
            {"name": "20260201-100000_initial"},
            {"name": "20260201-100100_add_field"},
        ]

        migrator = MigrationService(mock_db, migrations_dir)
        applied = migrator._get_applied_migrations()

        assert applied == {"20260201-100000_initial", "20260201-100100_add_field"}

    def test_pending_excludes_applied_migrations(self, tmp_path):
        """Pending migrations exclude already-applied ones."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE;")
        (migrations_dir / "20260201-100100_add_field.surql").write_text("DEFINE FIELD;")

        mock_db = MagicMock()
        mock_db.query.return_value = [{"name": "20260201-100000_initial"}]

        migrator = MigrationService(mock_db, migrations_dir)
        pending = migrator._get_pending_migrations()
        names = [name for name, _ in pending]

        assert names == ["20260201-100100_add_field"]

    def test_pending_migrations_empty_directory(self, tmp_path):
        """_get_pending_migrations returns empty list for missing directory."""
        migrations_dir = tmp_path / "migrations"

        mock_db = MagicMock()
        migrator = MigrationService(mock_db, migrations_dir)

        pending = migrator._get_pending_migrations()

        assert pending == []


class TestMigrationExecution:
    """Tests for migration execution and error handling."""

    def test_migrate_executes_pending(self, tmp_path):
        """migrate() executes all pending migrations."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE test;")
        (migrations_dir / "20260201-100100_add_field.surql").write_text("DEFINE FIELD name;")

        mock_db = MagicMock()
        mock_db.query.return_value = []

        migrator = MigrationService(mock_db, migrations_dir)
        applied = migrator.migrate()

        assert len(applied) == 2
        assert "20260201-100000_initial" in applied
        assert "20260201-100100_add_field" in applied

    def test_migrate_records_applied(self, tmp_path):
        """migrate() records applied migrations."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE test;")

        mock_db = MagicMock()
        mock_db.query.return_value = []

        migrator = MigrationService(mock_db, migrations_dir)
        migrator.migrate()

        mock_db.create.assert_called_once()
        call_args = mock_db.create.call_args
        assert call_args[0][0] == "_migrations"
        assert call_args[0][1]["name"] == "20260201-100000_initial"

    def test_migrate_no_pending(self, tmp_path):
        """migrate() returns empty list when no pending migrations."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE test;")

        mock_db = MagicMock()
        mock_db.query.return_value = [{"name": "20260201-100000_initial"}]

        migrator = MigrationService(mock_db, migrations_dir)
        applied = migrator.migrate()

        assert applied == []

    def test_migrate_failure_raises_runtime_error(self, tmp_path):
        """migrate() raises RuntimeError on migration failure."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("INVALID SQL;")

        mock_db = MagicMock()
        mock_db.query.side_effect = [
            None,  # _ensure_migrations_table query
            [],  # _get_applied_migrations query
            Exception("SQL syntax error"),  # migration query fails
        ]

        migrator = MigrationService(mock_db, migrations_dir)

        with pytest.raises(RuntimeError, match="Migration.*failed"):
            migrator.migrate()

    def test_migrate_failure_does_not_record(self, tmp_path):
        """Failed migration is not recorded; subsequent migrations skipped."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("INVALID SQL;")
        (migrations_dir / "20260201-100100_other.surql").write_text("VALID SQL;")

        mock_db = MagicMock()
        mock_db.query.side_effect = [
            None,  # _ensure_migrations_table query
            [],  # _get_applied_migrations query
            Exception("SQL syntax error"),  # migration query fails
        ]

        migrator = MigrationService(mock_db, migrations_dir)

        with pytest.raises(RuntimeError):
            migrator.migrate()

        mock_db.create.assert_not_called()

    def test_status_returns_applied_and_pending(self, tmp_path):
        """status() returns sorted applied and pending lists."""
        migrations_dir = tmp_path / "migrations"
        migrations_dir.mkdir()

        (migrations_dir / "20260201-100000_initial.surql").write_text("DEFINE TABLE;")
        (migrations_dir / "20260201-100100_add_field.surql").write_text("DEFINE FIELD;")
        (migrations_dir / "20260201-100200_index.surql").write_text("DEFINE INDEX;")

        mock_db = MagicMock()
        mock_db.query.return_value = [
            {"name": "20260201-100100_add_field"},
            {"name": "20260201-100000_initial"},
        ]

        migrator = MigrationService(mock_db, migrations_dir)
        status = migrator.status()

        assert status["applied"] == [
            "20260201-100000_initial",
            "20260201-100100_add_field",
        ]
        assert status["pending"] == ["20260201-100200_index"]
