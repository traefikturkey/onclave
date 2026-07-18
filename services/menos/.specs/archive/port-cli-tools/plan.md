# Team Plan: Port CLI Tools from agent-spike to menos

## Objective
Port applicable CLI functionality from `agent-spike/compose/cli/` into the menos project. Menos is a self-hosted content vault with YouTube ingestion via FastAPI + SurrealDB + MinIO. It already has core YouTube services (transcript fetching, metadata, ingestion script) but lacks channel-level fetching, CLI query tools, and URL classification.

## Source Analysis

### What agent-spike has vs menos:

| agent-spike Script | Menos Equivalent | Action |
|---|---|---|
| `fetch_channel_videos.py` | None | **Port** - Channel-level video discovery to CSV |
| `filter_description_urls.py` | `extract_urls()` only | **Port** - Add content vs marketing classification |
| `url_filter_status.py` | None | **Port** - Dashboard for URL filter stats |
| `update_video_metadata.py` | `refetch_metadata.py` exists | **Skip** - Already covered |
| `list_videos.py` | API only, no CLI | **Port** - CLI wrapper for listing videos |
| `search_videos.py` | API only, no CLI | **Port** - CLI wrapper for semantic search |
| `delete_video.py` | No equivalent | **Port** - CLI video deletion with confirmation |
| `migrate_to_surrealdb.py` | N/A | **Skip** - agent-spike migration specific |
| `populate_surrealdb_from_archive.py` | N/A | **Skip** - agent-spike migration specific |
| `backfill_embeddings.py` | N/A | **Skip** - agent-spike migration specific |
| `validate_data.py` | N/A | **Skip** - agent-spike migration specific |
| `base.py` | None | **Skip** - Menos uses standard package imports |

### Scripts to Port (6 total):
1. `fetch_channel_videos.py` - Fetch all videos from a YouTube channel to CSV
2. `filter_description_urls.py` - Classify URLs in video descriptions (heuristic only)
3. `url_filter_status.py` - URL classification stats display
4. `list_videos.py` - CLI to list videos in SurrealDB
5. `search_videos.py` - CLI semantic search
6. `delete_video.py` - CLI video deletion

## Project Context
- **Language**: Python 3.12+
- **Package manager**: uv
- **Test command**: `cd api && uv run pytest -v`
- **Lint command**: `cd api && uv run ruff check .`
- **Target directory**: `api/scripts/` (existing script location in menos)
- **Services directory**: `api/menos/services/` (business logic)
- **Config**: `api/menos/config.py` (Pydantic Settings, already has `youtube_api_key`)

## Adaptation Notes

Scripts must be adapted to menos patterns:
- Use `menos.config.settings` for configuration (not `os.getenv` + env_loader)
- Use `menos.services.youtube_metadata.YouTubeMetadataService` (already has `_get_client()` returning Google API client)
- Use `menos.services.di.get_storage_context()` async context manager for DB+MinIO access
- Use `menos.services.storage.SurrealDBRepository` methods for DB queries
- Use `menos.services.storage.MinIOStorage` for object storage
- Use `menos.services.embeddings.EmbeddingService` for vector search
- `google-api-python-client` already in `pyproject.toml` dependencies
- No `base.py` setup needed — menos uses `PYTHONPATH=. uv run python scripts/foo.py`
- Follow ruff lint rules (line-length 100, select E/F/I/UP)
- Scripts should run from `api/` directory

### Async Pattern for Scripts
Scripts using `get_storage_context()` follow this pattern:
```python
import asyncio
from menos.services.di import get_storage_context

async def main():
    async with get_storage_context() as (minio, repo):
        # Use repo.list_content(), repo.delete_content(), etc.
        pass

if __name__ == "__main__":
    asyncio.run(main())
```

### Key menos APIs Available
- `repo.list_content(offset, limit, content_type, tags)` → `(list[ContentMetadata], int)`
  - NOTE: The returned int is `len(items)`, NOT a true total count. For pagination, use a raw count query: `repo.db.query("SELECT count() FROM content WHERE content_type = 'youtube' GROUP ALL")`
- `repo.get_content(content_id)` → `ContentMetadata | None`
- `repo.delete_content(content_id)` → None
- `repo.get_chunks(content_id)` → `list[ChunkModel]`
- `repo.delete_chunks(content_id)` → None
- `repo.delete_links_by_source(content_id)` → None
- `repo.delete_content_entity_edges(content_id)` → None
- `repo._parse_query_result(result)` → list[dict] (helper for raw queries)
- `EmbeddingService.embed_query(text)` → `list[float]` (adds search prefix)
- `YouTubeMetadataService._get_client()` → Google API client

### Content Model for YouTube Videos
YouTube videos are `content` records with `content_type="youtube"`. Video-specific data is in the `metadata` dict:
- `metadata.video_id` — YouTube video ID
- `metadata.channel_id` — Channel ID
- `metadata.channel_title` — Channel name
- `metadata.language` — Transcript language
- `metadata.duration_seconds` — Video duration

### Existing URL Handling
- `menos.services.youtube_metadata.extract_urls(text)` — Extracts all HTTP URLs from text (already exists, reuse it)
- `menos.services.url_detector.URLDetector` — Detects GitHub/arXiv/DOI/PyPI/npm URLs (complementary, not overlapping)

## Team Members
| Name | Agent | Role |
|------|-------|------|
| port-cli-builder | builder (sonnet) | Implement all scripts |
| port-cli-validator | validator (haiku) | Verify lint, tests, no secrets |

## Tasks

### Task 1: Port channel video fetcher
- **Owner**: port-cli-builder
- **Blocked By**: none
- **Description**: Create `api/scripts/fetch_channel_videos.py` adapted from agent-spike's version.
  - Use `YouTubeMetadataService._get_client()` to get the Google API client (avoid creating a new one)
  - Use `menos.config.settings.youtube_api_key` via the service (it reads it automatically)
  - Support `channel_url` positional arg, `--months` (default 12), `--output` (auto-generated from channel name)
  - Output CSV to `data/` directory (relative to repo root, use `Path(__file__).parent.parent.parent / "data"`)
  - Port `get_channel_id()`, `get_channel_videos()`, `parse_duration()`, `save_to_csv()` from agent-spike
  - Reference source: `C:\Projects\Personal\agent-spike\compose\cli\fetch_channel_videos.py`
- **Acceptance Criteria**:
  - [ ] Script exists at `api/scripts/fetch_channel_videos.py`
  - [ ] Uses `YouTubeMetadataService` for API client access
  - [ ] Accepts channel URL, months-back, and output file arguments
  - [ ] Outputs CSV with title, url, upload_date, view_count, duration, description
  - [ ] Passes `ruff check`

### Task 2: Create CLI query tools (list, search, delete)
- **Owner**: port-cli-builder
- **Blocked By**: none
- **Description**: Create three scripts in `api/scripts/`. All use `get_storage_context()` for DB/MinIO.

  **list_videos.py** — List YouTube videos from SurrealDB:
  - Use `repo.list_content(content_type="youtube", limit=limit, offset=offset)` for video list
  - For total count, run raw query: `repo.db.query("SELECT count() FROM content WHERE content_type = 'youtube' GROUP ALL")`
  - Display: index, title (truncated to 60 chars), video_id, channel name, YouTube URL
  - Support `--limit` (default 50), `--offset` (default 0)
  - Show pagination hint ("Next page: --offset N") when more results exist
  - Reference source: `C:\Projects\Personal\agent-spike\compose\cli\list_videos.py`

  **search_videos.py** — Semantic search using Ollama embeddings:
  - Create `EmbeddingService` via `get_embedding_service()` from `menos.services.embeddings`
  - Generate query embedding with `embedding_service.embed_query(query)`
  - Run vector similarity query against SurrealDB chunks (same pattern as `menos/routers/search.py` lines 110-120):
    ```sql
    SELECT text, content_id,
           vector::similarity::cosine(embedding, $embedding) AS score
    FROM chunk
    WHERE vector::similarity::cosine(embedding, $embedding) > 0.3
    ORDER BY score DESC
    LIMIT $limit
    ```
  - Group by content_id, keep best score per content
  - Fetch content metadata for matched IDs
  - Display: rank, title, score, video_id, channel, URL
  - Support `query` positional arg, `--limit` (default 10)
  - Reference source: `C:\Projects\Personal\agent-spike\compose\cli\search_videos.py`

  **delete_video.py** — Delete a YouTube video with confirmation:
  - Accept `video_id` (YouTube video ID, not SurrealDB content ID)
  - Look up content by querying: find content where `content_type='youtube'` and `metadata.video_id` matches
  - Show video details (title, channel, content_id) before confirming
  - On confirmation, delete in order: chunks, entity edges, links, MinIO files, content record
  - Use `repo.delete_chunks()`, `repo.delete_content_entity_edges()`, `repo.delete_links_by_source()`, `minio.delete()`, `repo.delete_content()`
  - Support `--yes` / `-y` to skip confirmation
  - Reference source: `C:\Projects\Personal\agent-spike\compose\cli\delete_video.py`

- **Acceptance Criteria**:
  - [ ] Three scripts exist in `api/scripts/`
  - [ ] Each uses `get_storage_context()` for DB/MinIO access
  - [ ] list_videos supports --limit and --offset with proper total count
  - [ ] search_videos generates embeddings via Ollama and runs vector search
  - [ ] delete_video looks up video by YouTube video_id, deletes all associated data
  - [ ] delete_video requires confirmation unless --yes
  - [ ] All pass `ruff check`

### Task 3: Create URL classification service and scripts
- **Owner**: port-cli-builder
- **Blocked By**: none
- **Description**: Create a heuristic URL classification system. NOTE: agent-spike has complex LLM + pattern learning. Port ONLY the heuristic rules. The scripts need to be rewritten for SurrealDB (agent-spike uses file-based archives).

  **1. `api/menos/services/url_filter.py`** — Heuristic URL classification service:
  - Port from agent-spike's `compose/services/youtube/url_filter.py`
  - Port these constants: `BLOCKED_DOMAINS` (gumroad, patreon, ko-fi, bit.ly, linktree, etc.), `BLOCKED_URL_PATTERNS` (checkout, buy, affiliate, utm), `SOCIAL_PROFILE_PATTERNS` (twitter profile, instagram profile, etc.)
  - Port `is_blocked_by_heuristic(url)` → `(bool, str | None)` — checks domain, URL patterns, social profiles
  - Port `apply_heuristic_filter(urls)` → dict with `blocked` and `remaining` lists
  - DO NOT port: `classify_url_with_llm()`, pattern learning, Anthropic client. Skip all LLM logic.
  - Reuse `menos.services.youtube_metadata.extract_urls()` for URL extraction (already exists, don't duplicate)

  **2. `api/scripts/filter_description_urls.py`** — CLI to classify video description URLs:
  - This is a REWRITE, not a direct port (agent-spike uses ArchiveManager, menos uses SurrealDB)
  - Accept `video_id` positional arg OR `--all` flag
  - For single video: query SurrealDB for content where `metadata.video_id` matches → get description from MinIO metadata.json OR from `metadata.description_urls` → run heuristic filter → print results
  - For --all: iterate all YouTube content, run filter, accumulate stats
  - Support `--dry-run` (show results without updating) — when not dry-run, update content metadata with `url_filter_results` dict
  - Use `get_storage_context()` for DB/MinIO access

  **3. `api/scripts/url_filter_status.py`** — URL classification stats:
  - This is a REWRITE (agent-spike version reads from PatternTracker, menos reads from SurrealDB)
  - Query all YouTube content from SurrealDB
  - Count: total videos, videos with URLs, videos filtered, total URLs, content URLs, blocked URLs
  - Display summary table
  - Use `get_storage_context()` for DB access

- **Acceptance Criteria**:
  - [ ] `api/menos/services/url_filter.py` exists with heuristic classification
  - [ ] `api/scripts/filter_description_urls.py` works with SurrealDB (not file archives)
  - [ ] `api/scripts/url_filter_status.py` shows stats from SurrealDB
  - [ ] Heuristic rules cover: marketing domains, affiliate/tracking URLs, social media profiles
  - [ ] Reuses `extract_urls()` from `youtube_metadata.py` (no duplication)
  - [ ] All pass `ruff check`

### Task 4: Add unit tests for new functionality
- **Owner**: port-cli-builder
- **Blocked By**: Task 1, Task 2, Task 3
- **Description**: Add tests for the URL filter service (the only new service-layer code). Scripts are harder to unit test, so focus on the service:
  - `api/tests/unit/test_url_filter.py` - Test heuristic classification rules
  Tests should use existing test patterns in menos (pytest, MagicMock for sync methods).
- **Acceptance Criteria**:
  - [ ] `api/tests/unit/test_url_filter.py` exists
  - [ ] Tests cover content URL detection (github, docs, blog URLs pass through)
  - [ ] Tests cover marketing URL blocking (patreon, gumroad, affiliate links blocked)
  - [ ] Tests cover social profile blocking (twitter.com/user blocked, but tweet URLs pass)
  - [ ] Tests cover edge cases (empty input, no URLs, mixed URLs)
  - [ ] All tests pass with `cd api && uv run pytest -v`

### Task 5: Update project documentation
- **Owner**: port-cli-builder
- **Blocked By**: Task 1, Task 2, Task 3
- **Description**: Update project docs to reflect the new scripts and service.

  **1. `.claude/rules/dev-commands.md`** — Add new script commands under the Scripts section:
  ```
  PYTHONPATH=. uv run python scripts/fetch_channel_videos.py URL  # Fetch channel videos to CSV
  PYTHONPATH=. uv run python scripts/list_videos.py               # List YouTube videos
  PYTHONPATH=. uv run python scripts/search_videos.py "query"     # Semantic search
  PYTHONPATH=. uv run python scripts/delete_video.py VIDEO_ID     # Delete a video
  PYTHONPATH=. uv run python scripts/filter_description_urls.py --all  # Classify URLs
  PYTHONPATH=. uv run python scripts/url_filter_status.py         # URL filter stats
  ```

  **2. `.claude/rules/architecture.md`** — Update the directory tree to include new files:
  - Add to `api/scripts/`: fetch_channel_videos.py, list_videos.py, search_videos.py, delete_video.py, filter_description_urls.py, url_filter_status.py
  - Add to `api/menos/services/`: url_filter.py

- **Acceptance Criteria**:
  - [ ] `.claude/rules/dev-commands.md` lists all new script commands
  - [ ] `.claude/rules/architecture.md` directory tree includes new files

### Task 6: Validate all changes
- **Owner**: port-cli-validator
- **Blocked By**: Task 1, Task 2, Task 3, Task 4, Task 5
- **Description**: Run linters, tests, and content checks on all builder output. Verify no hardcoded secrets, no debug statements, all files follow menos patterns.
- **Acceptance Criteria**:
  - [ ] `cd api && uv run ruff check .` passes
  - [ ] `cd api && uv run pytest -v` passes
  - [ ] No hardcoded API keys or secrets
  - [ ] No debug print statements left behind
  - [ ] Scripts use menos service patterns consistently (get_storage_context, settings, etc.)
  - [ ] No duplicated URL extraction logic (uses youtube_metadata.extract_urls)

## Dependency Graph
```
Task 1 (channel fetcher)  --\
Task 2 (CLI tools)         --+--> Task 4 (tests) + Task 5 (docs) --> Task 6 (validator)
Task 3 (URL filter)       --/
```
