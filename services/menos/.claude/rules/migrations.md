---
paths:
  - "api/migrations/**"
  - "api/scripts/migrate.py"
  - "api/menos/services/migrator.py"
---

# Database Migrations

Custom migration system for SurrealDB. See [ADR-001](docs/adr/001-database-migrations.md) for design rationale.

## Migration Files

Versioned `.surql` files in `api/migrations/`:
```
api/migrations/
├── 20260201-100000_initial_schema.surql
├── 20260201-100100_add_indexes.surql
└── ...
```

**Naming**: `YYYYMMDD-HHMMSS_description.surql`

## Commands

```bash
cd api
uv run python scripts/migrate.py status    # Check status
uv run python scripts/migrate.py up        # Apply pending
uv run python scripts/migrate.py create add_user_preferences  # New migration
```

## How It Works

1. Migrations tracked in `_migrations` table in SurrealDB
2. Each migration runs once and is recorded with its timestamp
3. Migrations execute in filename order (timestamp ensures sequence)
4. All migrations use `IF NOT EXISTS` for idempotency
5. Migrations run automatically on app startup via lifespan handler

## Writing Migrations

```sql
-- Always use IF NOT EXISTS for safety
DEFINE TABLE IF NOT EXISTS feature_flag SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS name ON feature_flag TYPE string;
DEFINE FIELD IF NOT EXISTS enabled ON feature_flag TYPE bool DEFAULT false;
DEFINE INDEX IF NOT EXISTS idx_feature_flag_name ON feature_flag FIELDS name UNIQUE;
```

## Vector Indexes

Vector indexes use `CONCURRENTLY` to build in the background. Monitor:
```sql
INFO FOR INDEX idx_chunk_embedding ON chunk;
-- Returns: {"building":{"status":"indexing"}} or {"status":"ready"}
```
