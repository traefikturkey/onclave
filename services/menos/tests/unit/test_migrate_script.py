"""Unit tests for the PostgreSQL migration CLI."""

from unittest.mock import MagicMock, patch

import scripts.migrate as migrate_module


def _run(command, result):
    database = MagicMock()
    migrator = MagicMock()
    getattr(migrator, command).return_value = result
    function = getattr(migrate_module, f"cmd_{'up' if command == 'migrate' else command}")
    with (
        patch("scripts.migrate.get_database", return_value=database),
        patch("scripts.migrate.MigrationService", return_value=migrator),
    ):
        return function(MagicMock()), database


def test_status_shows_applied_pending_and_closes_database(capsys):
    result, database = _run(
        "status",
        {
            "applied": ["20260201-100000_initial"],
            "pending": ["20260201-100100_add_field"],
        },
    )
    assert result == 0
    assert capsys.readouterr().out.splitlines() == [
        "[x] 20260201-100000_initial",
        "[ ] 20260201-100100_add_field",
    ]
    database.open.assert_called_once()
    database.close.assert_called_once()


def test_status_shows_none(capsys):
    assert _run("status", {"applied": [], "pending": []})[0] == 0
    assert capsys.readouterr().out.strip() == "(none)"


def test_up_reports_applied_migrations(capsys):
    result, database = _run("migrate", ["20260201-100000_initial", "20260201-100100_add_field"])
    assert result == 0
    assert capsys.readouterr().out.splitlines() == [
        "Applied 2 migration(s):",
        "[x] 20260201-100000_initial",
        "[x] 20260201-100100_add_field",
    ]
    database.close.assert_called_once()


def test_up_reports_no_pending(capsys):
    assert _run("migrate", [])[0] == 0
    assert capsys.readouterr().out.strip() == "No pending migrations."


def test_create_normalizes_name_and_writes_postgresql_template(tmp_path):
    args = MagicMock(name="args")
    args.name = "Add-Link Table"
    now = MagicMock()
    now.strftime.return_value = "20260215-120000"
    now.isoformat.return_value = "2026-02-15T12:00:00+00:00"
    with (
        patch("scripts.migrate.MIGRATIONS_DIR", tmp_path / "migrations"),
        patch("scripts.migrate.datetime") as clock,
    ):
        clock.now.return_value = now
        assert migrate_module.cmd_create(args) == 0

    path = tmp_path / "migrations" / "20260215-120000_add_link_table.sql"
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "-- Migration: add_link_table" in content
    assert "-- Add PostgreSQL statements here." in content


def test_parser_routes_commands():
    parser = migrate_module.build_parser()
    assert parser.parse_args(["up"]).handler is migrate_module.cmd_up
    assert parser.parse_args(["status"]).handler is migrate_module.cmd_status
    args = parser.parse_args(["create", "new table"])
    assert args.handler is migrate_module.cmd_create
    assert args.name == "new table"
