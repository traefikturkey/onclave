# SurrealDB Skill

Activate when working with SurrealDB queries, migrations, vector indexes, or the `menos/services/storage.py` file.

## Query Performance

### Direct Record Access (Fastest)

```sql
-- Direct ID access - O(1), no table scan
SELECT * FROM user:19374837491;

-- Range selection - avoids full scan
SELECT * FROM user:12647931632..=19374837491;
```

### Avoid Function Calls in WHERE

Pre-compute boolean fields instead of calling functions repeatedly:

```sql
-- SLOW: function called for every row
SELECT * FROM person WHERE random_data.len() < 10;

-- FAST: pre-computed field uses index
SELECT * FROM person WHERE is_short;
```

### UPDATE/DELETE Index Limitation

**Indexes are NOT used in UPDATE/DELETE statements** (as of v2.x). Wrap with SELECT subquery:

```sql
-- Without subquery: full table scan
UPDATE user SET adult = false WHERE age < 18;

-- With subquery: uses index on age
UPDATE (SELECT id FROM user WHERE age < 18) SET adult = false;
DELETE (SELECT id FROM user WHERE age < 18);
```

### UPSERT with Unique Index

For single-record updates, UPSERT with unique index is most efficient:

```sql
DEFINE INDEX email_index ON user FIELDS email UNIQUE;
UPSERT user SET name = "Bob", email = "bob@bob.com";
-- Uses index directly, no table scan
```

## Vector Indexes

### Creating Indexes on Large Tables

**Always use `CONCURRENTLY`** for vector indexes on tables with existing data:

```sql
DEFINE INDEX idx_chunk_embedding ON chunk
    FIELDS embedding
    MTREE DIMENSION 1024
    DIST COSINE
    CONCURRENTLY;
```

Without `CONCURRENTLY`, index creation on 30k+ records fails with:
> "Failed to commit transaction due to a read or write conflict"

This happens because standard `DEFINE INDEX` runs in a single long transaction that conflicts with SurrealDB's MVCC system after 10-20 minutes.

### Monitoring Index Progress

```sql
INFO FOR INDEX idx_chunk_embedding ON chunk;
```

Returns:
- Building: `{"building":{"initial":N,"pending":0,"status":"indexing"}}`
- Complete: `{"building":{"initial":N,"pending":0,"status":"ready","updated":0}}`

### Index Types

| Type | Use Case |
|------|----------|
| MTREE | General vector similarity (default choice) |
| HNSW | Higher recall, more memory |
| BTree | Scalar fields (content_id, created_at) |

### Dimension Matching

Embedding dimension must match the model:
- `mxbai-embed-large`: 1024 dimensions
- `nomic-embed-text`: 768 dimensions
- `all-MiniLM-L6-v2`: 384 dimensions

Mismatched dimensions cause: "Incorrect vector dimension (X). Expected a vector of Y dimension."

### Vector Similarity Search

```sql
SELECT text, content_id,
       vector::similarity::cosine(embedding, $embedding) AS score
FROM chunk
WHERE embedding <|10,COSINE|> $embedding
ORDER BY score DESC
LIMIT $limit;
```

## Graph Relations (RELATE)

### Basic Syntax

```sql
-- Create relation: vertex -> edge -> vertex
RELATE person:alex->follows->person:tobie SET followed_at = time::now();

-- With metadata on edge
RELATE writer:one->wrote->blog:one SET stars = 5, reviewed = true;

-- Multiple targets
RELATE person:aristotle->wrote->[article:one, article:two] SET era = "ancient";
```

### Querying Graph Edges

```sql
-- Forward traversal
SELECT ->wrote->post.* AS posts FROM user:alice;

-- Reverse traversal
SELECT <-wrote<-author AS authors FROM post:helloworld;

-- Filter on edge properties
SELECT ->knows[WHERE strength = "high"]->person AS close_friends FROM person:alex;

-- Edge tables are real tables
SELECT in, out, followed_at FROM follows WHERE in = person:alex;
```

### Edge Table Structure

Edges have `in` (source), `out` (target), and `id` fields:

```sql
-- Define typed relation table
DEFINE TABLE follows TYPE RELATION IN person OUT person;

-- Query edge metadata
SELECT *, in.name AS from_name, out.name AS to_name FROM follows;
```

## Python SDK

### Sync vs Async Classes

```python
# Synchronous (this project uses this)
from surrealdb import Surreal
db = Surreal("ws://localhost:8000/rpc")
db.signin({"username": "root", "password": "root"})
result = db.query("SELECT * FROM person")

# Asynchronous
from surrealdb import AsyncSurreal
async with AsyncSurreal("ws://localhost:8000/rpc") as db:
    await db.signin({"username": "root", "password": "root"})
    result = await db.query("SELECT * FROM person")
```

### Native Types vs Strings

Use native Python types with `db.create()`, not ISO strings:

```python
# Correct - native datetime
from datetime import datetime, UTC
db.create("_migrations", {
    "name": name,
    "applied_at": datetime.now(UTC)
})

# Wrong - string rejected with type error
db.create("_migrations", {
    "name": name,
    "applied_at": datetime.now(UTC).isoformat()
})
```

### SurrealDB v2 RecordID Objects

Query results return `RecordID` objects, not strings:

```python
result = db.query("SELECT * FROM content")
record_id = result[0]["id"]  # RecordID object

# Convert to string
content_id = str(record_id)  # "content:abc123"
content_id = record_id.id    # "abc123" (just the ID part)
```

### Query Result Structure

```python
# Single query returns list of records
result = db.query("SELECT * FROM content LIMIT 1")
# Returns: [{"id": RecordID, "field": value, ...}]

# Multiple statements returns list of lists
result = db.query("SELECT count() FROM content; SELECT count() FROM chunk;")
# Returns: [[{"count": N}], [{"count": M}]]
```

### SDK Methods

| Method | Description |
|--------|-------------|
| `db.query(sql, vars)` | Execute SurrealQL with optional parameters |
| `db.select(thing)` | Select all records or specific record |
| `db.create(thing, data)` | Create a new record |
| `db.insert(thing, data)` | Insert one or multiple records |
| `db.update(thing, data)` | Replace all fields in record |
| `db.merge(thing, data)` | Partial update (merge fields) |
| `db.patch(thing, data)` | JSON Patch operations |
| `db.delete(thing)` | Delete records |
| `db.live(table, callback)` | Subscribe to live queries (WebSocket only) |

## Live Queries

### Requirements

- WebSocket connection required (not HTTP)
- Callback signature: `def callback(data: Dict) -> None`
- LQ disappears on connection close - must recreate
- Only receives events AFTER LQ creation

```python
def on_change(data: dict) -> None:
    print(f"Change detected: {data}")

# Subscribe to changes
live_id = db.live("person", on_change)

# Unsubscribe
db.kill(live_id)
```

### Live Query vs Change Feed

| Feature | Live Query | Change Feed |
|---------|------------|-------------|
| Transport | WebSocket only | HTTP and WebSocket |
| Scope | Table only | Table or database |
| History | Events after creation only | Can replay historic changes |
| Use case | Real-time UI updates | Event sourcing, audit logs |

## Security

### Password Hashing

Use dedicated password functions, not general hashes:

```sql
-- Correct
crypto::argon2::generate($password)
crypto::argon2::compare($hash, $password)

-- Also acceptable
crypto::bcrypt::generate($password)
crypto::scrypt::generate($password)

-- WRONG - never use for passwords
crypto::md5($password)
crypto::sha256($password)
```

### Session/Token Duration

Always set explicit durations:

```sql
DEFINE ACCESS user ON DATABASE TYPE RECORD
    SIGNUP ( CREATE user SET email = $email, pass = crypto::argon2::generate($pass) )
    SIGNIN ( SELECT * FROM user WHERE email = $email AND crypto::argon2::compare(pass, $pass) )
    DURATION FOR SESSION 12h, FOR TOKEN 15m;
```

### Parameterized Queries

Always use parameters for untrusted input:

```python
# Correct - parameterized
db.query("SELECT * FROM user WHERE email = $email", {"email": user_input})

# WRONG - SQL injection vulnerability
db.query(f"SELECT * FROM user WHERE email = '{user_input}'")
```

### Debug Authentication Errors

For development only:

```bash
# Forward auth errors to client (exposes internal errors!)
SURREAL_INSECURE_FORWARD_ACCESS_ERRORS=true
```

## Migrations

### File Naming

`YYYYMMDD-HHMMSS_description.surql`

Example: `20260201-100100_add_indexes.surql`

### Idempotent Patterns

```sql
-- Tables and fields
DEFINE TABLE IF NOT EXISTS content SCHEMAFULL;
DEFINE FIELD IF NOT EXISTS title ON content TYPE string;

-- Indexes (use IF NOT EXISTS, but still need CONCURRENTLY for large tables)
DEFINE INDEX IF NOT EXISTS idx_name ON table FIELDS field;

-- Removing before recreating (for dimension changes)
REMOVE INDEX IF EXISTS idx_chunk_embedding ON chunk;
DEFINE INDEX idx_chunk_embedding ON chunk FIELDS embedding MTREE DIMENSION 1024 DIST COSINE CONCURRENTLY;
```

### Migration Tracking

Migrations are tracked in `_migrations` table:

```sql
SELECT * FROM _migrations ORDER BY applied_at;
```

## Known Issues & Workarounds

### DELETE ONLY Bug

```sql
-- This fails (ONLY expects result but DELETE returns nothing)
DELETE ONLY person:one;

-- Workaround: add RETURN
DELETE ONLY person:one RETURN $before;
```

### Closure Variable Limitation

Closures don't see query variables - `$var` shows as NONE inside closures:

```sql
-- $now is NONE inside the closure
LET $now = time::now();
SELECT * FROM events WHERE items.filter(|$e| $e.time > $now);
-- Workaround: restructure query to avoid closures with variables
```

### Graph WHERE Clause Edge Case

WHERE clauses can behave unexpectedly with graph arrow syntax in some cases. Test thoroughly when combining `->` traversal with WHERE filters.

## Troubleshooting

| Error | Cause | Solution |
|-------|-------|----------|
| Transaction conflict on index | Long-running transaction | Use `CONCURRENTLY` |
| Incorrect vector dimension | Model/index mismatch | Check embedding model dimensions |
| Field type error with datetime | Using `.isoformat()` | Pass native `datetime` object |
| Index is corrupted | Large table indexing bug | Upgrade SurrealDB, use `CONCURRENTLY` |
| InvalidAuth (generic) | Auth failure | Set `SURREAL_INSECURE_FORWARD_ACCESS_ERRORS=true` to debug |
| DELETE ONLY fails | Known bug | Add `RETURN $before` |
| UPDATE/DELETE slow on indexed field | Indexes not used | Wrap with `SELECT id` subquery |

## Useful Commands

```sql
-- Database info
INFO FOR DB;

-- Table structure
INFO FOR TABLE chunk;

-- Index status
INFO FOR INDEX idx_chunk_embedding ON chunk;

-- Count records
SELECT count() FROM chunk GROUP ALL;

-- Check SurrealDB version (via HTTP)
-- curl http://localhost:8000/version
```

## References

### Official Documentation
- [SurrealDB Docs Home](https://surrealdb.com/docs)
- [SurrealQL Statements](https://surrealdb.com/docs/surrealql/statements)
- [DEFINE INDEX](https://surrealdb.com/docs/surrealql/statements/define/indexes)
- [RELATE Statement](https://surrealdb.com/docs/surrealql/statements/relate)
- [Vector Functions](https://surrealdb.com/docs/surrealql/functions/database/vector)

### Python SDK
- [Python SDK Overview](https://surrealdb.com/docs/sdk/python)
- [SDK Methods Reference](https://surrealdb.com/docs/sdk/python/methods)
- [Real-Time Streaming](https://surrealdb.com/docs/sdk/python/concepts/streaming)
- [GitHub: surrealdb.py](https://github.com/surrealdb/surrealdb.py)

### Best Practices
- [Performance Best Practices](https://surrealdb.com/docs/surrealdb/reference-guide/performance-best-practices)
- [Security Best Practices](https://surrealdb.com/docs/surrealdb/reference-guide/security-best-practices)
- [Known Issues](https://surrealdb.com/docs/surrealdb/faqs/known-issues)

### Data Models
- [Using as Vector Database](https://surrealdb.com/docs/surrealdb/models/vector)
- [Using as Graph Database](https://surrealdb.com/docs/surrealdb/models/graph)
- [Full-Text Search](https://surrealdb.com/docs/surrealdb/models/full-text-search)

### Tutorials
- [SurrealDB Fundamentals](https://surrealdb.com/learn/fundamentals)
- [Graph Relations](https://surrealdb.com/learn/fundamentals/relationships/graph-relations)
- [Indexing & Data Model](https://surrealdb.com/learn/fundamentals/performance/index-data-model)

### Community
- [GitHub Issues](https://github.com/surrealdb/surrealdb/issues)
- [GitHub Discussions](https://github.com/orgs/surrealdb/discussions)
- [SurrealDB Blog](https://surrealdb.com/blog)
- [Release Notes](https://surrealdb.com/releases)
