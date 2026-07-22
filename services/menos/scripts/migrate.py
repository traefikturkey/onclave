#!/usr/bin/env python3
"""Manage PostgreSQL schema migrations."""

import argparse
import re
from datetime import UTC, datetime
from pathlib import Path

from menos.config import settings
from menos.services.database import PostgresDatabase
from menos.services.migrator import MigrationService

MIGRATIONS_DIR = Path(__file__).parents[1] / "migrations"


def get_database() -> PostgresDatabase:
    return PostgresDatabase(
        host=settings.postgres_host,
        port=settings.postgres_port,
        database=settings.postgres_database,
        user=settings.postgres_user,
        password=settings.postgres_password,
        min_size=1,
        max_size=1,
    )


def cmd_status(_args: argparse.Namespace) -> int:
    database = get_database()
    database.open()
    try:
        status = MigrationService(database, MIGRATIONS_DIR).status()
        names = [
            *(f"[x] {name}" for name in status["applied"]),
            *(f"[ ] {name}" for name in status["pending"]),
        ]
        print("\n".join(names) if names else "(none)")
        return 0
    finally:
        database.close()


def cmd_up(_args: argparse.Namespace) -> int:
    database = get_database()
    database.open()
    try:
        applied = MigrationService(database, MIGRATIONS_DIR).migrate()
        if not applied:
            print("No pending migrations.")
            return 0
        print(f"Applied {len(applied)} migration(s):")
        for name in applied:
            print(f"[x] {name}")
        return 0
    finally:
        database.close()


def cmd_create(args: argparse.Namespace) -> int:
    normalized = re.sub(r"[^a-z0-9]+", "_", args.name.lower()).strip("_")
    if not normalized:
        raise ValueError("Migration name must contain letters or digits")
    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    path = MIGRATIONS_DIR / f"{now.strftime('%Y%m%d-%H%M%S')}_{normalized}.sql"
    content = (
        f"-- Migration: {normalized}\n"
        f"-- Created: {now.isoformat()}\n\n"
        "-- Add PostgreSQL statements here.\n"
    )
    path.write_text(content, encoding="utf-8")
    print(f"Created migration: {path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    commands.add_parser("up").set_defaults(handler=cmd_up)
    commands.add_parser("status").set_defaults(handler=cmd_status)
    create = commands.add_parser("create")
    create.add_argument("name")
    create.set_defaults(handler=cmd_create)
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    handler = getattr(args, "handler", cmd_up)
    raise SystemExit(handler(args))


if __name__ == "__main__":
    main()
