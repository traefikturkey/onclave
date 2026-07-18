# Test Content

## Overview
Content tagged with "test" is excluded from production queries by default. This keeps test/development content (e.g., Rick Astley) from polluting real results.

## Default Behavior
- `GET /api/v1/content` and `POST /api/v1/search` exclude content tagged "test" by default
- The `exclude_tags` parameter defaults to `["test"]` when omitted
- This applies to all content types (YouTube, markdown, etc.)

## Viewing Test Content

### Include all content (test + production)
- Content list: `GET /api/v1/content?exclude_tags=`
- Search: `POST /api/v1/search` with `{"exclude_tags": []}`

### Show only test content
- Content list: `GET /api/v1/content?tags=test`
- When `tags` includes "test", the default exclusion for "test" is automatically removed

### CLI
- `list_videos.py --all` — include test content in listing
- `list_videos.py --test` — show only test content

## Tagging Content as Test

### During ingestion
- CLI: `ingest_video.py VIDEO_ID --test`
- API: Include `"tags": ["test"]` in ingest request

### After ingestion
- `PATCH /api/v1/content/{id}` with updated tags list

## Development vs Production
- **Development/troubleshooting**: Use `exclude_tags=` or `--all` to see everything
- **Production/normal use**: Default behavior hides test content automatically
- **Debugging missing content**: If content seems missing, check if it has the "test" tag
