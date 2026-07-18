# Menos

Self-hosted content vault with semantic search. Centralized store for markdown/frontmatter files and structured data accessible from multiple machines.

## Status

**Phase 5 Complete** - Agentic search with LLM-powered query expansion and answer synthesis.

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│  REST API       │────▶│  SurrealDB      │────▶│  HNSW Vector    │
│  (FastAPI)      │     │  (metadata +    │     │  Index          │
│                 │     │   embeddings)   │     │                 │
└────────┬────────┘     └─────────────────┘     └─────────────────┘
         │
         │              ┌─────────────────┐     ┌─────────────────┐
         └─────────────▶│  MinIO          │     │  Ollama         │
                        │  (file storage) │     │  (mxbai-embed)  │
                        └─────────────────┘     └─────────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| **SurrealDB** | Metadata + vector search (HNSW indexes) |
| **MinIO** | S3-compatible file storage |
| **Ollama** | Local embeddings (mxbai-embed-large) |
| **FastAPI** | REST API with RFC 9421 HTTP signature auth |

## Authentication

Uses [RFC 9421 HTTP Message Signatures](https://datatracker.ietf.org/doc/rfc9421/) with ed25519 keys.

1. Register your SSH public key with the service
2. Sign requests with your private key
3. Server verifies signature against registered public key

Your existing `~/.ssh/id_ed25519` key works directly.

## Quick Start

### Local Development

```bash
cd api

# Install dependencies
uv sync

# Run tests
uv run pytest

# Run locally (port 8000)
uv run uvicorn menos.main:app --reload
```

### Remote Deployment

```bash
cd infra/ansible

# Deploy full stack
docker compose run --rm ansible ansible-playbook -i inventory/hosts.yml playbooks/deploy.yml
```

### Smoke Tests

Run smoke tests against a deployed API:

```bash
cd api

# Against local development server
uv run python scripts/smoke_test.py

# Against production
uv run python scripts/smoke_test.py --url https://api.example.com

# With custom SSH key
uv run python scripts/smoke_test.py --key-file /path/to/key -v
```

Environment variables:
- `SMOKE_TEST_URL` - API base URL (default: http://localhost:8000)
- `SMOKE_TEST_KEY_FILE` - SSH private key path (default: ~/.ssh/id_ed25519)

## API Endpoints

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/health` | No | Health check |
| GET | `/ready` | No | Readiness check |
| **Auth** |
| GET | `/api/v1/auth/keys` | No | List authorized key IDs |
| GET | `/api/v1/auth/whoami` | Yes | Verify authentication |
| POST | `/api/v1/auth/keys/reload` | Yes | Reload keys from disk |
| **Content** |
| GET | `/api/v1/content` | Yes | List content (supports `?tags=a,b` and `?content_type=x` filtering) |
| GET | `/api/v1/content/{id}` | Yes | Get content metadata |
| POST | `/api/v1/content` | Yes | Upload content (supports `?tags=a&tags=b`, auto-extracts frontmatter) |
| PATCH | `/api/v1/content/{id}` | Yes | Update metadata (tags, title, description) |
| DELETE | `/api/v1/content/{id}` | Yes | Delete content |
| GET | `/api/v1/content/{id}/links` | Yes | Get forward links from this document |
| GET | `/api/v1/content/{id}/backlinks` | Yes | Get backlinks to this document |
| **Tags** |
| GET | `/api/v1/tags` | Yes | List all tags with counts |
| **Search** |
| POST | `/api/v1/search` | Yes | Semantic vector search (supports `tags` filter in body) |
| POST | `/api/v1/search/agentic` | Yes | Agentic search with query expansion and synthesis |
| **Graph** |
| GET | `/api/v1/graph` | Yes | Full knowledge graph (nodes + edges for visualization) |
| GET | `/api/v1/graph/neighborhood/{id}` | Yes | Local graph neighborhood (1-3 hops) |
| **YouTube** |
| POST | `/api/v1/youtube/ingest` | Yes | Ingest YouTube video by URL |
| GET | `/api/v1/youtube/{video_id}` | Yes | Get YouTube video info |
| GET | `/api/v1/youtube` | Yes | List ingested videos (supports `?channel_id=x` filtering) |
| GET | `/api/v1/youtube/channels` | Yes | List channels with video counts |

## Project Structure

```
menos/
├── api/                    # FastAPI application
│   ├── menos/
│   │   ├── auth/           # RFC 9421 signature verification
│   │   ├── client/         # Request signing client
│   │   ├── routers/        # API endpoints
│   │   └── services/       # SurrealDB, MinIO, Ollama, YouTube
│   ├── scripts/            # Utility scripts
│   ├── tests/              # Unit and integration tests
│   ├── Dockerfile
│   └── pyproject.toml
├── infra/
│   └── ansible/            # Deployment automation
│       ├── files/menos/    # Remote compose stack
│       ├── inventory/      # Server configuration
│       └── playbooks/      # Deploy, update, backup
├── data/                   # Data files (video lists, etc.)
├── docs/                   # Documentation
└── _archive/               # Previous implementations
```

## Configuration

Environment variables (set in `.env`):

| Variable | Description |
|----------|-------------|
| `SURREALDB_URL` | SurrealDB connection URL |
| `SURREALDB_PASSWORD` | SurrealDB root password |
| `MINIO_URL` | MinIO server endpoint |
| `MINIO_ACCESS_KEY` | MinIO access key |
| `MINIO_SECRET_KEY` | MinIO secret key |
| `OLLAMA_URL` | Ollama API URL |
| `AGENT_EXPANSION_PROVIDER` | LLM for query expansion (ollama/openai/anthropic/none) |
| `AGENT_SYNTHESIS_PROVIDER` | LLM for answer synthesis (ollama/openai/anthropic/none) |
| `AGENT_RERANK_PROVIDER` | Reranker backend (rerankers/llm/none) |
| `OPENAI_API_KEY` | OpenAI API key (if using OpenAI providers) |
| `ANTHROPIC_API_KEY` | Anthropic API key (if using Anthropic providers) |

## Implementation Status

- [x] Phase -1: Archive v0 scaffold
- [x] Phase 0: Infrastructure (Ansible, Compose)
- [x] Phase 1: API scaffold with RFC 9421 auth
- [x] Phase 2: Storage (MinIO + SurrealDB integration)
- [x] Phase 3: Search (Ollama embeddings + chunking)
- [x] Phase 4: YouTube ingestion
- [x] Phase 5: Agentic search (query expansion, reranking, synthesis)
- [x] Phase 6: PKM features (tags, frontmatter, links, graph visualization)

## PKM Features

Menos includes Personal Knowledge Management features for organizing and connecting content:

- **Tagging**: Add tags via API or YAML frontmatter, filter content and search by tags
- **Frontmatter Parsing**: Auto-extracts `title` and `tags` from markdown YAML frontmatter
- **Link Extraction**: Wiki-links `[[Title]]` and markdown links auto-extracted during upload
- **Bidirectional Links**: Query forward links and backlinks between documents
- **Graph Visualization**: Export knowledge graph as nodes/edges for D3.js, Cytoscape, etc.

## License

MIT
