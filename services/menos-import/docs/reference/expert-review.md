# Expert Review Suggestions

This document captures suggested expert perspectives for reviewing and improving Menos.

## 1. Information Retrieval / RAG Specialist

**Focus**: Search quality and retrieval architecture

### Review Areas
- Chunking strategy (512 tokens / 50 overlap) - optimization for content types
- Embedding model choice - mxbai-embed-large vs alternatives (e5, bge, nomic-embed)
- RRF fusion parameters and reranking effectiveness
- Query expansion prompts and their impact on recall
- Hybrid search (BM25 + vector) potential
- Evaluation methodology for search quality

### Potential Improvements
- MTEB benchmark comparisons
- Late-interaction models (ColBERT)
- Hypothetical document embeddings (HyDE)
- Adaptive chunking based on content structure
- Search quality metrics and A/B testing framework

---

## 2. Personal Knowledge Management (PKM) / Second Brain Expert

**Focus**: User workflows and ecosystem integration

### Review Areas
- Integration with existing PKM tools (Obsidian, Logseq, Notion)
- Frontmatter schema design for interoperability
- Missing features users expect (tagging, linking, graph views)
- CLI/API ergonomics for daily use
- Sync patterns for multi-device access

### Potential Improvements
- Obsidian plugin for seamless sync
- Bidirectional linking between documents
- Daily notes integration
- Zotero/reference manager integration
- Browser extension for web clipping
- Graph visualization of knowledge connections

**Status**: ✅ **IMPLEMENTED** (2026-02-01) - See [PKM Features Implementation](#pkm-features-implementation)

---

## 3. MLOps / Production AI Systems Engineer

**Focus**: Scalability, reliability, and operational concerns

### Review Areas
- Embedding pipeline performance and caching strategies
- SurrealDB vector index scaling characteristics
- Ollama resource management and request queuing
- Monitoring/observability for LLM-based systems
- Batch ingestion performance
- Graceful degradation when Ollama is unavailable

### Potential Improvements
- Embedding cache layer (avoid re-embedding unchanged content)
- Async batch processing queue
- Request rate limiting
- OpenTelemetry tracing for LLM calls
- GPU utilization metrics
- Model warm-up strategies on startup

---

## PKM Features Implementation

**Review Date**: 2026-02-01
**Implementation Date**: 2026-02-01
**Status**: ✅ **COMPLETE**

### Executive Summary

All core PKM features have been implemented. Menos now supports tagging, frontmatter parsing, bidirectional linking, and graph visualization.

| Feature | Status | Implementation |
|---------|--------|----------------|
| Tags | ✅ Complete | API, filtering, frontmatter extraction |
| Frontmatter parsing | ✅ Complete | `FrontmatterParser` service |
| Wiki-style links | ✅ Complete | `LinkExtractor` service |
| Backlinks | ✅ Complete | `/content/{id}/backlinks` endpoint |
| Graph visualization | ✅ Complete | `/graph` and `/graph/neighborhood/{id}` |
| YouTube channels | ✅ Complete | `/youtube/channels`, channel filtering |
| Collections/folders | Not implemented | Future consideration |

---

### Implemented Features

#### 1. Tagging System ✅

**Endpoints**:
- `POST /api/v1/content?tags=a&tags=b` - Create content with tags
- `PATCH /api/v1/content/{id}` - Update tags (and title, description)
- `GET /api/v1/tags` - List all tags with counts
- `GET /api/v1/content?tags=a,b` - Filter by tags (AND logic)
- `POST /api/v1/search` - Accepts `tags` filter in request body

**Features**:
- Tags from query parameters merged with frontmatter tags
- Deduplicated (explicit tags take precedence)
- YouTube API tags synced to database
- BTree index for efficient filtering

**Files**:
- `api/menos/routers/content.py` - Tag endpoints
- `api/migrations/20260201-170000_add_content_tags_index.surql` - Tag index

---

#### 2. Frontmatter Parsing ✅

**Service**: `api/menos/services/frontmatter.py`

**Capabilities**:
- Parses YAML frontmatter from markdown files during upload
- Extracts `title` field → populates content title if not provided
- Extracts `tags` field → merged with explicit API tags
- Graceful handling of malformed YAML
- Ignores non-markdown files

**Example**:
```yaml
---
title: My Document
tags:
  - python
  - api
---
# Content here
```

---

#### 3. Bidirectional Linking ✅

**Service**: `api/menos/services/linking.py`

**Link Extraction**:
- Wiki-links: `[[Title]]` and `[[Title|display text]]`
- Markdown links: `[text](internal-path)` (external URLs skipped)
- Ignores links in code blocks
- Stores unresolved links (target=null) for future resolution

**Database Schema** (`api/migrations/20260201-160600_add_link_edge_table.surql`):
```sql
DEFINE TABLE link SCHEMAFULL;
DEFINE FIELD source ON link TYPE record<content>;
DEFINE FIELD target ON link TYPE record<content>;
DEFINE FIELD link_text ON link TYPE string;
DEFINE FIELD link_type ON link TYPE string;  -- wiki, markdown
DEFINE FIELD created_at ON link TYPE datetime DEFAULT time::now();
DEFINE INDEX idx_link_source ON link FIELDS source;
DEFINE INDEX idx_link_target ON link FIELDS target;
```

**Endpoints**:
- `GET /api/v1/content/{id}/links` - Forward links (this doc links to...)
- `GET /api/v1/content/{id}/backlinks` - Backlinks (these link to this doc)

---

#### 4. Graph Visualization ✅

**Router**: `api/menos/routers/graph.py`

**Endpoints**:
- `GET /api/v1/graph` - Full knowledge graph
  - Query params: `tags`, `content_type`, `limit` (1-1000, default 500)
- `GET /api/v1/graph/neighborhood/{id}` - Local neighborhood
  - Query params: `depth` (1-3, default 1)

**Response Format**:
```json
{
  "nodes": [
    {"id": "abc123", "title": "Doc Title", "content_type": "document", "tags": ["python"]}
  ],
  "edges": [
    {"source": "abc123", "target": "def456", "link_type": "wiki", "link_text": "Related Doc"}
  ]
}
```

**Usage**: Compatible with D3.js, Cytoscape.js, vis.js, or custom visualization.

---

#### 5. YouTube Channels ✅

**Endpoints**:
- `GET /api/v1/youtube?channel_id=xxx` - Filter videos by channel
- `GET /api/v1/youtube/channels` - List channels with video counts

**Response** (channels):
```json
{
  "channels": [
    {"channel_id": "UCxxx", "channel_title": "Channel Name", "video_count": 15}
  ]
}
```

---

### Future Improvements

The following were identified but not implemented:

1. **Hierarchical tags** (`#project/menos`) - Currently flat tags only
2. **Inline hashtag extraction** (`#tag` in content) - Only frontmatter tags extracted
3. **Semantic similarity edges** - Graph shows explicit links only, not similarity-based connections
4. **Playlist support** - YouTube playlists not tracked
5. **Graph clustering** - No topic cluster endpoint
6. **Frontend visualization** - API only, no built-in UI (use external tools)
7. **Obsidian plugin** - API-compatible but no official plugin

---

### Test Coverage

- 240 unit/integration tests passing
- Tests cover all new endpoints, services, and edge cases
- Link extraction tested with complex markdown (code blocks, nested brackets, etc.)
