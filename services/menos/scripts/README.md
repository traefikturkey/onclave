# Scripts

Utility scripts for Menos maintenance and operations.

## reprocess_content.py

Reprocesses existing content to populate PKM (Personal Knowledge Management) data structures.

### What it does

1. **Markdown/Document files**:
   - Fetches content from MinIO
   - Parses YAML frontmatter to extract tags
   - Merges frontmatter tags with existing tags in database
   - Extracts wiki-links (`[[Title]]`) and markdown links (`[text](path)`)
   - Stores links in the `link` table with target resolution
   - Updates content tags in database

2. **YouTube videos**:
   - Fetches `metadata.json` from MinIO
   - Extracts tags from YouTube metadata
   - Merges with existing tags in database

### Features

- **Idempotent**: Safe to run multiple times (deletes existing links before recreating)
- **Dry-run mode**: Preview changes without applying them
- **Comprehensive logging**: Shows progress, extracted tags/links, counts
- **Error handling**: Continues processing on individual failures
- **Link resolution**: Attempts to match link targets to existing content by title

### Usage

```bash
# Preview changes without applying
cd api
PYTHONPATH=. uv run python scripts/reprocess_content.py --dry-run

# Apply changes
PYTHONPATH=. uv run python scripts/reprocess_content.py
```

### Prerequisites

- SurrealDB running and accessible
- MinIO running with content stored
- Environment variables configured (via `.env` or exported):
  - `SURREALDB_URL`
  - `SURREALDB_USER`
  - `SURREALDB_PASSWORD`
  - `SURREALDB_NAMESPACE`
  - `SURREALDB_DATABASE`
  - `MINIO_URL`
  - `MINIO_ACCESS_KEY`
  - `MINIO_SECRET_KEY`
  - `MINIO_BUCKET`

### Output

The script logs:
- Total items processed
- Tags extracted and updated
- Links created
- Errors encountered
- Processing time

Example output:
```
2025-02-01 12:00:00 - INFO - Starting content reprocessing...
2025-02-01 12:00:00 - INFO - Connecting to MinIO at localhost:9000
2025-02-01 12:00:00 - INFO - Connecting to SurrealDB at http://localhost:8000
2025-02-01 12:00:01 - INFO - Connected to SurrealDB successfully
2025-02-01 12:00:01 - INFO - Fetching batch 1 (offset=0, limit=50)
2025-02-01 12:00:01 - INFO - Processing document: abc123 - My Note
2025-02-01 12:00:01 - INFO -   Found 3 tags in frontmatter, adding 2 new tags
2025-02-01 12:00:01 - INFO -   Found 5 links
2025-02-01 12:00:01 - INFO -     Resolved link 'Other Note' -> 'def456'
2025-02-01 12:00:01 - INFO -     Unresolved link 'Missing Page'
...
2025-02-01 12:00:10 - INFO - ================================================================================
2025-02-01 12:00:10 - INFO - Reprocessing complete!
2025-02-01 12:00:10 - INFO - Duration: 9.45 seconds
2025-02-01 12:00:10 - INFO - Total items: 42
2025-02-01 12:00:10 - INFO - Processed: 38
2025-02-01 12:00:10 - INFO - Skipped: 2
2025-02-01 12:00:10 - INFO - Errors: 2
2025-02-01 12:00:10 - INFO - Tags updated: 15
2025-02-01 12:00:10 - INFO - Links created: 87
2025-02-01 12:00:10 - INFO - ================================================================================
```

### Notes

- Existing links are deleted before recreation to ensure idempotency
- Unresolved links (targets not found by title) are stored with `target=None`
- The script processes content in batches of 50 items
- Non-markdown files without special handling are skipped
- Tags are deduplicated (won't add duplicate tags to existing content)

## Other Scripts

- **ingest_videos.py**: Bulk ingest YouTube videos from a file
- **refetch_metadata.py**: Refetch YouTube metadata for existing videos
- **smoke_test.py**: Run smoke tests against a live deployment
- **migrate.py**: Run database migrations
