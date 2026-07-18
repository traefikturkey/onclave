"""Database migration service for SurrealDB.

Manages schema migrations using versioned .surql files.
Migrations are tracked in a _migrations table to ensure idempotency.
"""

import logging
import re
from datetime import UTC, datetime
from pathlib import Path

from surrealdb import Surreal

logger = logging.getLogger(__name__)

# Pattern: YYYYMMDD-HHMMSS_migration_name.surql
MIGRATION_PATTERN = re.compile(r"^(\d{8}-\d{6})_(.+)\.surql$")


class MigrationService:
    """Handles database schema migrations."""

    def __init__(self, db: Surreal, migrations_dir: Path | str):
        """Initialize migration service.

        Args:
            db: Connected SurrealDB instance (must be signed in and using namespace/database)
            migrations_dir: Directory containing .surql migration files
        """
        self.db = db
        self.migrations_dir = Path(migrations_dir)

    def _ensure_migrations_table(self) -> None:
        """Create _migrations table if it doesn't exist."""
        self.db.query("""
            DEFINE TABLE IF NOT EXISTS _migrations SCHEMAFULL;
            DEFINE FIELD IF NOT EXISTS name ON _migrations TYPE string;
            DEFINE FIELD IF NOT EXISTS applied_at ON _migrations TYPE datetime;
            DEFINE INDEX IF NOT EXISTS idx_migration_name ON _migrations FIELDS name UNIQUE;
        """)

    def _get_applied_migrations(self) -> set[str]:
        """Get set of already-applied migration names."""
        result = self.db.query("SELECT name FROM _migrations")
        if result and isinstance(result, list):
            # Handle both old and new SurrealDB response formats
            if isinstance(result[0], dict) and "result" in result[0]:
                rows = result[0]["result"]
            else:
                rows = result
            return {row["name"] for row in rows if isinstance(row, dict)}
        return set()

    def _record_migration(self, name: str) -> None:
        """Record a migration as applied."""
        self.db.create("_migrations", {"name": name, "applied_at": datetime.now(UTC)})

    def _get_pending_migrations(self) -> list[tuple[str, Path]]:
        """Get list of pending migrations sorted by timestamp.

        Returns:
            List of (migration_name, file_path) tuples sorted by version
        """
        if not self.migrations_dir.exists():
            return []

        applied = self._get_applied_migrations()
        pending = []

        for file_path in self.migrations_dir.glob("*.surql"):
            match = MIGRATION_PATTERN.match(file_path.name)
            if match:
                name = file_path.stem  # filename without extension
                if name not in applied:
                    pending.append((name, file_path))

        # Sort by filename (timestamp prefix ensures correct order)
        return sorted(pending, key=lambda x: x[0])

    def migrate(self) -> list[str]:
        """Run all pending migrations.

        Returns:
            List of applied migration names
        """
        self._ensure_migrations_table()
        pending = self._get_pending_migrations()

        if not pending:
            logger.info("No pending migrations")
            return []

        applied = []
        for name, file_path in pending:
            logger.info(f"Applying migration: {name}")
            try:
                sql = file_path.read_text(encoding="utf-8")
                self.db.query(sql)
                self._record_migration(name)
                applied.append(name)
                logger.info(f"Applied migration: {name}")
            except Exception as e:
                logger.error(f"Migration failed: {name} - {e}")
                raise RuntimeError(f"Migration {name} failed: {e}") from e

        return applied

    def status(self) -> dict[str, list[str]]:
        """Get migration status.

        Returns:
            Dict with 'applied' and 'pending' migration lists
        """
        self._ensure_migrations_table()
        applied = sorted(self._get_applied_migrations())
        pending = [name for name, _ in self._get_pending_migrations()]

        return {"applied": applied, "pending": pending}
