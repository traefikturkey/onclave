"""Transactional PostgreSQL schema migration service."""

import logging
import re
from pathlib import Path

from menos.services.database import PostgresDatabase

logger = logging.getLogger(__name__)
MIGRATION_PATTERN = re.compile(r"^(\d{8}-\d{6})_(.+)\.sql$")


class MigrationService:
    """Apply versioned SQL files exactly once in filename order."""

    def __init__(self, database: PostgresDatabase, migrations_dir: Path | str):
        self._database = database
        self.migrations_dir = Path(migrations_dir)

    def _migration_files(self) -> list[Path]:
        if not self.migrations_dir.exists():
            raise RuntimeError(f"Migrations directory not found: {self.migrations_dir}")
        files = sorted(
            path for path in self.migrations_dir.glob("*.sql") if MIGRATION_PATTERN.match(path.name)
        )
        if not files:
            raise RuntimeError(f"No PostgreSQL migrations found in {self.migrations_dir}")
        return files

    def _applied(self) -> set[str]:
        with self._database.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """CREATE TABLE IF NOT EXISTS schema_migration (
                name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"""
            )
            cursor.execute("SELECT name FROM schema_migration")
            return {row["name"] for row in cursor.fetchall()}

    def migrate(self) -> list[str]:
        applied = self._applied()
        completed: list[str] = []
        for path in self._migration_files():
            name = path.stem
            if name in applied:
                continue
            statement = path.read_text(encoding="utf-8")
            logger.info("Applying PostgreSQL migration: %s", name)
            try:
                with self._database.connection() as connection:
                    with connection.transaction(), connection.cursor() as cursor:
                        cursor.execute(statement)
                        cursor.execute("INSERT INTO schema_migration(name) VALUES (%s)", (name,))
            except Exception as error:
                raise RuntimeError(f"Migration {name} failed: {error}") from error
            completed.append(name)
        return completed

    def status(self) -> dict[str, list[str]]:
        applied = sorted(self._applied())
        pending = [path.stem for path in self._migration_files() if path.stem not in applied]
        return {"applied": applied, "pending": pending}
