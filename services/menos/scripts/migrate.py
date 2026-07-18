#!/usr/bin/env python
"""Database migration CLI for menos.

Usage:
    uv run python scripts/migrate.py status    # Show migration status
    uv run python scripts/migrate.py up        # Apply pending migrations
    uv run python scripts/migrate.py create <name>  # Create new migration file
"""

import argparse
import sys
from datetime import UTC, datetime
from pathlib import Path

from surrealdb import Surreal

# Add parent to path for menos imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from menos.config import get_settings
from menos.services.migrator import MigrationService

MIGRATIONS_DIR = Path(__file__).parent.parent / "migrations"


def get_db() -> Surreal:
    """Create and connect to database."""
    settings = get_settings()
    db = Surreal(settings.surrealdb_url)
    db.signin({"username": settings.surrealdb_user, "password": settings.surrealdb_password})
    db.use(settings.surrealdb_namespace, settings.surrealdb_database)
    return db


def cmd_status(args: argparse.Namespace) -> int:
    """Show migration status."""
    db = get_db()
    migrator = MigrationService(db, MIGRATIONS_DIR)
    status = migrator.status()

    print("Applied migrations:")
    if status["applied"]:
        for name in status["applied"]:
            print(f"  [x] {name}")
    else:
        print("  (none)")

    print("\nPending migrations:")
    if status["pending"]:
        for name in status["pending"]:
            print(f"  [ ] {name}")
    else:
        print("  (none)")

    return 0


def cmd_up(args: argparse.Namespace) -> int:
    """Apply pending migrations."""
    db = get_db()
    migrator = MigrationService(db, MIGRATIONS_DIR)

    print("Checking for pending migrations...")
    applied = migrator.migrate()

    if applied:
        print(f"\nApplied {len(applied)} migration(s):")
        for name in applied:
            print(f"  [x] {name}")
    else:
        print("No pending migrations.")

    return 0


def cmd_create(args: argparse.Namespace) -> int:
    """Create a new migration file."""
    name = args.name.lower().replace(" ", "_").replace("-", "_")
    timestamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    filename = f"{timestamp}_{name}.surql"
    filepath = MIGRATIONS_DIR / filename

    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)

    template = f"""-- Migration: {name}
-- Created: {datetime.now(UTC).isoformat()}

-- Add your SurrealQL statements here
-- Example:
-- DEFINE TABLE IF NOT EXISTS example SCHEMAFULL;
-- DEFINE FIELD IF NOT EXISTS name ON example TYPE string;
"""

    filepath.write_text(template, encoding="utf-8")
    print(f"Created migration: {filepath}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Database migration tool for menos",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  uv run python scripts/migrate.py status
  uv run python scripts/migrate.py up
  uv run python scripts/migrate.py create add_user_table
        """,
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    # status command
    subparsers.add_parser("status", help="Show migration status")

    # up command
    subparsers.add_parser("up", help="Apply pending migrations")

    # create command
    create_parser = subparsers.add_parser("create", help="Create new migration file")
    create_parser.add_argument("name", help="Migration name (e.g., add_user_table)")

    args = parser.parse_args()

    commands = {
        "status": cmd_status,
        "up": cmd_up,
        "create": cmd_create,
    }

    return commands[args.command](args)


if __name__ == "__main__":
    sys.exit(main())
