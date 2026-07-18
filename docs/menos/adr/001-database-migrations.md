# ADR-001: Database Migration System

## Status

Accepted

## Context

Menos uses SurrealDB for metadata and vector storage. As the application evolves, we need a way to:

1. Define and version database schema changes
2. Apply changes consistently across environments (dev, staging, production)
3. Track which migrations have been applied
4. Ensure migrations are idempotent and safe to re-run

### Options Considered

| Tool | Language | Pros | Cons |
|------|----------|------|------|
| [surrealdb-migrations](https://github.com/Odonno/surrealdb-migrations) | Rust | Mature, rollback support | Requires Rust toolchain or Docker |
| [HPE surrealdb_migrations](https://github.com/HPENetworking/surrealdb-migrations) | Python | Native Python | v0.1.0, appears unmaintained |
| [smig](https://smig.build/) | TypeScript | Auto-diff schemas | Requires TypeScript setup |
| Custom solution | Python | Full control, no deps | No automatic rollback |

## Decision

Implement a lightweight custom migration system in Python:

- **Migration files**: Versioned `.surql` files in `api/migrations/`
- **Naming convention**: `YYYYMMDD-HHMMSS_description.surql`
- **Tracking**: `_migrations` table in SurrealDB stores applied migrations
- **Execution**: `MigrationService` class runs pending migrations in order

### Why Custom?

1. **Simplicity**: ~100 lines of Python, no external dependencies
2. **Integration**: Works naturally with existing uv/pytest tooling
3. **Control**: Full visibility into migration behavior
4. **Deployment**: Integrates with existing Ansible playbooks

### Trade-offs Accepted

- **No automatic rollback**: SurrealDB schema changes are mostly additive (DEFINE IF NOT EXISTS). Manual rollback scripts can be written if needed.
- **Manual versioning**: Developers must create correctly-named files. Mitigated by CLI helper script.

## Implementation

### Directory Structure

```
api/
├── migrations/
│   ├── 20260201-100000_initial_schema.surql
│   ├── 20260201-100100_add_indexes.surql
│   └── ...
├── menos/
│   └── services/
│       └── migrator.py
└── scripts/
    └── migrate.py
```

### Migration File Format

```sql
-- Description of what this migration does
-- Can contain any valid SurrealQL

DEFINE TABLE IF NOT EXISTS example SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON example TYPE string;
DEFINE INDEX IF NOT EXISTS idx_example_name ON example FIELDS name;
```

### Usage

```bash
# Check migration status
uv run python scripts/migrate.py status

# Apply pending migrations
uv run python scripts/migrate.py up

# Create new migration
uv run python scripts/migrate.py create add_user_preferences
```

### Programmatic Usage

```python
from menos.services.migrator import MigrationService
from surrealdb import Surreal

db = Surreal("ws://localhost:8000/rpc")
db.signin({"username": "root", "password": "root"})
db.use("menos", "menos")

migrator = MigrationService(db, "migrations/")
applied = migrator.migrate()
print(f"Applied {len(applied)} migrations")
```

## Consequences

### Positive

- Zero external dependencies for migrations
- Migrations run on app startup (optional) or via CLI
- Easy to test and debug
- Works with existing CI/CD pipeline

### Negative

- No built-in rollback (must write manual rollback scripts)
- No schema diffing (must write migrations manually)
- No migration dependencies (relies on timestamp ordering)

### Neutral

- Developers must follow naming convention
- Migration failures require manual intervention

## References

- [SurrealDB Schema Documentation](https://surrealdb.com/docs/surrealdb/surrealql/statements/define)
- [surrealdb-migrations (Odonno)](https://github.com/Odonno/surrealdb-migrations) - Reference implementation
