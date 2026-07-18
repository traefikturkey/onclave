"""Unit tests for migration CLI script."""

from unittest.mock import MagicMock, patch

import scripts.migrate as migrate_module


class TestStatusCommand:
    """Tests for 'status' command output."""

    def test_status_shows_applied_migrations(self, capsys):
        """status command shows applied migrations with checkmarks."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.status.return_value = {
            "applied": ["20260201-100000_initial", "20260201-100100_add_field"],
            "pending": [],
        }

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_status(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "[x] 20260201-100000_initial" in captured.out
        assert "[x] 20260201-100100_add_field" in captured.out

    def test_status_shows_pending_migrations(self, capsys):
        """status command shows pending migrations with empty checkboxes."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.status.return_value = {
            "applied": [],
            "pending": ["20260201-100000_initial", "20260201-100100_add_field"],
        }

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_status(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "[ ] 20260201-100000_initial" in captured.out
        assert "[ ] 20260201-100100_add_field" in captured.out

    def test_status_shows_no_migrations(self, capsys):
        """status command shows (none) when no migrations exist."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.status.return_value = {
            "applied": [],
            "pending": [],
        }

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_status(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "(none)" in captured.out

    def test_status_mixed_applied_pending(self, capsys):
        """status command shows both applied and pending."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.status.return_value = {
            "applied": ["20260201-100000_initial"],
            "pending": ["20260201-100100_add_field"],
        }

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_status(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "[x] 20260201-100000_initial" in captured.out
        assert "[ ] 20260201-100100_add_field" in captured.out


class TestUpCommand:
    """Tests for 'up' command output."""

    def test_up_reports_applied_count(self, capsys):
        """up command reports number of applied migrations."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.migrate.return_value = [
            "20260201-100000_initial",
            "20260201-100100_add_field",
        ]

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_up(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "Applied 2 migration(s):" in captured.out
        assert "[x] 20260201-100000_initial" in captured.out
        assert "[x] 20260201-100100_add_field" in captured.out

    def test_up_reports_no_pending(self, capsys):
        """up command reports when no pending migrations exist."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.migrate.return_value = []

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_up(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "No pending migrations." in captured.out

    def test_up_single_migration(self, capsys):
        """up command reports single applied migration."""
        mock_db = MagicMock()
        mock_migrator = MagicMock()
        mock_migrator.migrate.return_value = ["20260201-100000_initial"]

        with patch("scripts.migrate.get_db", return_value=mock_db):
            with patch(
                "scripts.migrate.MigrationService", return_value=mock_migrator
            ):
                result = migrate_module.cmd_up(MagicMock())

        assert result == 0
        captured = capsys.readouterr()
        assert "Applied 1 migration(s):" in captured.out


class TestCreateCommand:
    """Tests for 'create' command file generation."""

    def test_create_normalizes_filename(self, tmp_path):
        """create command normalizes migration name (lowercase, spaces to underscores)."""
        mock_args = MagicMock()
        mock_args.name = "Add User Table"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", tmp_path
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        files = list(tmp_path.glob("*.surql"))
        assert len(files) == 1
        assert "add_user_table" in files[0].name
        assert files[0].name.startswith("20260215-120000_")

    def test_create_converts_hyphens_to_underscores(self, tmp_path):
        """create command converts hyphens to underscores."""
        mock_args = MagicMock()
        mock_args.name = "add-link-table"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", tmp_path
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        files = list(tmp_path.glob("*.surql"))
        assert len(files) == 1
        assert "add_link_table" in files[0].name

    def test_create_writes_template(self, tmp_path):
        """create command writes template file with comment header."""
        mock_args = MagicMock()
        mock_args.name = "test_migration"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", tmp_path
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_now.isoformat.return_value = "2026-02-15T12:00:00+00:00"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        files = list(tmp_path.glob("*.surql"))
        content = files[0].read_text()

        assert "-- Migration: test_migration" in content
        assert "-- Created: 2026-02-15T12:00:00+00:00" in content
        assert "-- Add your SurrealQL statements here" in content

    def test_create_creates_directory(self, tmp_path):
        """create command creates migrations directory if missing."""
        missing_dir = tmp_path / "migrations"
        assert not missing_dir.exists()

        mock_args = MagicMock()
        mock_args.name = "initial"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", missing_dir
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        assert missing_dir.exists()

    def test_create_outputs_filepath(self, tmp_path, capsys):
        """create command prints created filepath."""
        mock_args = MagicMock()
        mock_args.name = "initial"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", tmp_path
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        captured = capsys.readouterr()
        assert "Created migration:" in captured.out
        assert "20260215-120000_initial.surql" in captured.out

    def test_create_lowercase_conversion(self, tmp_path):
        """create command converts uppercase to lowercase."""
        mock_args = MagicMock()
        mock_args.name = "Add_TABLE"

        with patch(
            "scripts.migrate.MIGRATIONS_DIR", tmp_path
        ):
            with patch("scripts.migrate.datetime") as mock_datetime:
                mock_now = MagicMock()
                mock_now.strftime.return_value = "20260215-120000"
                mock_datetime.now.return_value = mock_now

                result = migrate_module.cmd_create(mock_args)

        assert result == 0
        files = list(tmp_path.glob("*.surql"))
        assert "add_table" in files[0].name
