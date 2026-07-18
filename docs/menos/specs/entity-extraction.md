# Entity Extraction & Knowledge Graph Design

**Status:** Draft
**Created:** 2026-02-01
**Author:** Claude (with user direction)

## 1. Overview

### Problem Statement

Menos currently stores content (YouTube transcripts, markdown documents) with manual tags and explicit wiki-links. This requires human effort to organize and connect content. Users want automatic identification of:

- **Topics/subjects** discussed in content
- **GitHub repositories** and software tools mentioned
- **Research papers** cited or discussed
- **Other web-accessible resources**

These entities should become nodes in a knowledge graph, enabling:
- Automatic content connections based on shared entities
- Entity-centric browsing ("show all videos about LangChain")
- Rich filtering and discovery
- Hierarchical topic navigation

### Inspiration

This design draws from [Karakeep](https://github.com/karakeep-app/karakeep)'s approach to AI-based tagging, particularly:
- LLM-based entity extraction with structured prompts
- Tag normalization using generated columns and Levenshtein distance
- Limiting tag proliferation through prompt constraints
- Distinguishing AI-generated vs human-created tags

## 2. Goals

1. **Automatic entity extraction** from content during ingestion
2. **Hierarchical topic taxonomy** (General → Specific breadcrumb trails)
3. **Entity resolution** for GitHub repos, papers, and tools (even when not explicitly linked)
4. **Normalization and deduplication** to prevent entity sprawl
5. **First-class entity nodes** in the knowledge graph with rich metadata
6. **Typed edges** to distinguish relationship semantics
7. **Sponsored content filtering** to exclude irrelevant promotional links
8. **Provider-agnostic LLM design** (Ollama/qwen3 first, swappable later)
9. **Reprocessing capability** for existing content

## 3. Non-Goals (v1)

- Real-time entity updates when external sources change (e.g., repo stars)
- User-contributed entity corrections via UI
- Entity relationship inference (e.g., "LangChain uses FAISS")
- Embedding-based semantic similarity edges (future consideration)
- Full-text search within entity metadata

## 4. User Stories

### Content Discovery
> As a user, I want to see all videos that discuss "Retrieval Augmented Generation" so I can learn about the topic comprehensively.

### Entity Browsing
> As a user, I want to browse all GitHub repositories mentioned across my content, sorted by frequency, so I can discover tools I should explore.

### Topic Navigation
> As a user, I want hierarchical topics like "AI → LLMs → Prompt Engineering" so I can drill down from broad categories to specific concepts.

### Automatic Connections
> As a user, I want videos that discuss the same paper to be automatically connected, even if neither explicitly links to the other.

### Filtered Search
> As a user, I want to search my content filtered by entity (e.g., "show videos mentioning FastAPI") so I can find relevant material quickly.

## 5. Data Model

### 5.1 Entity Table

```sql
DEFINE TABLE entity SCHEMAFULL;

-- Core fields
DEFINE FIELD id ON entity TYPE string;
DEFINE FIELD entity_type ON entity TYPE string;  -- topic, repo, paper, tool, person
DEFINE FIELD name ON entity TYPE string;         -- Display name
DEFINE FIELD normalized_name ON entity TYPE string;  -- For matching (lowercase, no separators)
DEFINE FIELD description ON entity TYPE option<string>;
DEFINE FIELD hierarchy ON entity TYPE option<array<string>>;  -- ["AI", "LLMs", "RAG"] breadcrumb

-- Metadata (type-specific, stored as flexible object)
DEFINE FIELD metadata ON entity TYPE option<object>;
-- For repos: { url, owner, stars, language, topics, fetched_at }
-- For papers: { url, arxiv_id, doi, authors, abstract, published_at, fetched_at }
-- For topics: { aliases, parent_topic }
-- For tools: { url, category }

-- Tracking
DEFINE FIELD created_at ON entity TYPE datetime DEFAULT time::now();
DEFINE FIELD updated_at ON entity TYPE datetime DEFAULT time::now();
DEFINE FIELD source ON entity TYPE string;  -- "ai_extracted", "user_created", "api_fetched"

-- Indexes
DEFINE INDEX idx_entity_type ON entity FIELDS entity_type;
DEFINE INDEX idx_entity_normalized ON entity FIELDS normalized_name;
DEFINE INDEX idx_entity_hierarchy ON entity FIELDS hierarchy;
```

### 5.2 Content-Entity Edge Table

```sql
DEFINE TABLE content_entity SCHEMAFULL;

DEFINE FIELD content_id ON content_entity TYPE record<content>;
DEFINE FIELD entity_id ON content_entity TYPE record<entity>;
DEFINE FIELD edge_type ON content_entity TYPE string;  -- discusses, mentions, cites, uses
DEFINE FIELD confidence ON content_entity TYPE option<float>;  -- 0.0-1.0 extraction confidence
DEFINE FIELD mention_count ON content_entity TYPE option<int>;  -- How many times mentioned
DEFINE FIELD source ON content_entity TYPE string;  -- "ai_extracted", "url_detected", "user_added"
DEFINE FIELD created_at ON content_entity TYPE datetime DEFAULT time::now();

-- Indexes for traversal
DEFINE INDEX idx_ce_content ON content_entity FIELDS content_id;
DEFINE INDEX idx_ce_entity ON content_entity FIELDS entity_id;
DEFINE INDEX idx_ce_type ON content_entity FIELDS edge_type;
```

### 5.3 Entity-Entity Edge Table (Future)

```sql
DEFINE TABLE entity_relation SCHEMAFULL;

DEFINE FIELD source_entity ON entity_relation TYPE record<entity>;
DEFINE FIELD target_entity ON entity_relation TYPE record<entity>;
DEFINE FIELD relation_type ON entity_relation TYPE string;  -- uses, cites, parent_of, alias_of
DEFINE FIELD created_at ON entity_relation TYPE datetime DEFAULT time::now();

DEFINE INDEX idx_er_source ON entity_relation FIELDS source_entity;
DEFINE INDEX idx_er_target ON entity_relation FIELDS target_entity;
```

### 5.4 Edge Type Taxonomy

| Edge Type | From | To | Description |
|-----------|------|-----|-------------|
| `discusses` | Content | Topic | Primary subject matter of the content |
| `mentions` | Content | Any Entity | Referenced but not the main focus |
| `cites` | Content | Paper | Academic citation or detailed discussion |
| `uses` | Content | Repo/Tool | Demonstrates, recommends, or uses the tool |
| `demonstrates` | Content | Repo/Tool | Tutorial or walkthrough of the tool |

## 6. Entity Types

### 6.1 Topics (Hierarchical)

Topics are organized in a General → Specific hierarchy:

```
AI
├── Machine Learning
│   ├── Deep Learning
│   │   ├── Transformers
│   │   │   ├── Attention Mechanism
│   │   │   └── BERT
│   │   └── CNNs
│   └── Reinforcement Learning
├── LLMs
│   ├── Prompt Engineering
│   ├── RAG (Retrieval Augmented Generation)
│   ├── Fine-tuning
│   └── Agents
│       ├── Tool Use
│       ├── Multi-Agent Systems
│       └── Agentic Workflows
└── Computer Vision
```

**Stored as:**
```json
{
  "entity_type": "topic",
  "name": "RAG",
  "normalized_name": "rag",
  "hierarchy": ["AI", "LLMs", "RAG"],
  "metadata": {
    "aliases": ["Retrieval Augmented Generation", "retrieval-augmented generation"],
    "parent_topic": "entity:llms"
  }
}
```

### 6.2 GitHub Repositories

```json
{
  "entity_type": "repo",
  "name": "LangChain",
  "normalized_name": "langchain",
  "description": "Building applications with LLMs through composability",
  "metadata": {
    "url": "https://github.com/langchain-ai/langchain",
    "owner": "langchain-ai",
    "stars": 95000,
    "language": "Python",
    "topics": ["llm", "agents", "rag"],
    "fetched_at": "2026-02-01T12:00:00Z"
  }
}
```

### 6.3 Research Papers

```json
{
  "entity_type": "paper",
  "name": "Attention Is All You Need",
  "normalized_name": "attentionisallyouneed",
  "description": "Introduces the Transformer architecture",
  "metadata": {
    "url": "https://arxiv.org/abs/1706.03762",
    "arxiv_id": "1706.03762",
    "doi": "10.48550/arXiv.1706.03762",
    "authors": ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones", "Gomez", "Kaiser", "Polosukhin"],
    "abstract": "The dominant sequence transduction models are based on...",
    "published_at": "2017-06-12",
    "fetched_at": "2026-02-01T12:00:00Z"
  }
}
```

### 6.4 Tools/Software (Non-GitHub)

```json
{
  "entity_type": "tool",
  "name": "Ollama",
  "normalized_name": "ollama",
  "description": "Run large language models locally",
  "metadata": {
    "url": "https://ollama.ai",
    "category": "llm-runtime"
  }
}
```

## 7. Normalization Strategy

### 7.1 Name Normalization

Following Karakeep's approach:

```python
def normalize_name(name: str) -> str:
    """Normalize entity name for matching."""
    return name.lower().replace(" ", "").replace("-", "").replace("_", "")
```

Examples:
- "Machine Learning" → "machinelearning"
- "machine-learning" → "machinelearning"
- "LangChain" → "langchain"
- "lang_chain" → "langchain"

### 7.2 Duplicate Detection

**On Extraction:**
1. Normalize extracted entity name
2. Query for existing entity with matching `normalized_name`
3. If found, link to existing entity
4. If not found, create new entity

**Periodic Cleanup:**
Use Levenshtein distance to find near-duplicates:

```python
from Levenshtein import distance

def find_near_duplicates(entities: list[Entity], max_distance: int = 1) -> list[list[Entity]]:
    """Find entities that are likely duplicates based on edit distance."""
    groups = []
    for i, e1 in enumerate(entities):
        group = [e1]
        for e2 in entities[i+1:]:
            if distance(e1.normalized_name, e2.normalized_name) <= max_distance:
                group.append(e2)
        if len(group) > 1:
            groups.append(group)
    return groups
```

### 7.3 Alias Management

Entities can have multiple aliases that all resolve to the same canonical entity:

```json
{
  "name": "Retrieval Augmented Generation",
  "normalized_name": "retrievalaugmentedgeneration",
  "metadata": {
    "aliases": ["RAG", "retrieval-augmented generation", "retrieval augmented generation"]
  }
}
```

When extracting, check both `normalized_name` and aliases for matches.

## 8. Extraction Pipeline

### 8.0 Core Principle: Code-First, LLM-Last

> **CRITICAL DESIGN CONSTRAINT:** LLM calls are expensive (latency, cost, rate limits).
> The pipeline MUST extract as much as possible using fast, deterministic code-based
> methods BEFORE falling back to LLM inference. LLM should only handle ambiguous
> cases that code cannot resolve.

**Cost Hierarchy (prefer methods higher in list):**
1. **Regex patterns** - URLs, arXiv IDs, DOIs (free, instant, 100% precision)
2. **Keyword matching** - Known entity names against transcript (free, fast)
3. **Fuzzy matching** - Levenshtein distance against existing entities (cheap, fast)
4. **External APIs** - GitHub, arXiv, Semantic Scholar (rate-limited but deterministic)
5. **LLM inference** - Only for topic extraction and ambiguous entity resolution (expensive)

### 8.1 Pipeline Overview

```
┌─────────────┐    ┌──────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
│   Content   │───▶│ URL/Pattern  │───▶│  Keyword &   │───▶│ LLM Entity  │───▶│   Entity     │
│   Ingested  │    │  Detection   │    │ Fuzzy Match  │    │  Extraction │    │  Resolution  │
└─────────────┘    └──────────────┘    └──────────────┘    └─────────────┘    └──────────────┘
                          │                   │                   │                   │
                          ▼                   ▼                   ▼                   ▼
                   ┌──────────────┐    ┌──────────────┐    ┌─────────────┐    ┌──────────────┐
                   │ GitHub API   │    │  Existing    │    │ Topics ONLY │    │   Store      │
                   │ ArXiv API    │    │  Entity DB   │    │ (repos/     │    │   Edges      │
                   │ DOI Lookup   │    │  Lookup      │    │  papers     │    │              │
                   └──────────────┘    └──────────────┘    │  pre-found) │    └──────────────┘
                                                          └─────────────┘
```

**Key insight:** By the time we call the LLM, we should have already identified:
- All GitHub repos (via URL detection + keyword matching)
- All papers (via arXiv/DOI URLs + keyword matching against known papers)
- All tools/software (via keyword matching against known tools)

The LLM's primary job becomes **topic extraction** and **confidence scoring** for pre-detected entities.

### 8.2 Stage 1: URL/Pattern Detection (Code-Based)

Detect explicit references using regex patterns - **zero LLM cost:**

```python
PATTERNS = {
    "github_repo": r"github\.com/([a-zA-Z0-9_-]+)/([a-zA-Z0-9_-]+)",
    "arxiv": r"arxiv\.org/abs/(\d{4}\.\d{4,5})",
    "doi": r"doi\.org/(10\.\d{4,}/[^\s]+)",
    "pypi": r"pypi\.org/project/([a-zA-Z0-9_-]+)",
    "npm": r"npmjs\.com/package/([a-zA-Z0-9_-]+)",
}
```

For YouTube content:
1. Extract URLs from video description
2. Filter sponsored/affiliate links (patterns: `bit.ly`, `amzn.to`, tracking parameters)
3. Categorize remaining URLs
4. **Cross-reference with transcript** - only keep URLs whose domain is actually discussed

### 8.3 Stage 2: Keyword & Fuzzy Matching (Code-Based)

**Before calling any LLM**, scan content against known entities:

```python
class EntityKeywordMatcher:
    """Fast, code-based entity detection using keyword matching."""

    def __init__(self, entity_repo: EntityRepository):
        # Cache of known entities for fast lookup
        self.known_repos: dict[str, Entity] = {}      # normalized_name -> Entity
        self.known_papers: dict[str, Entity] = {}
        self.known_tools: dict[str, Entity] = {}
        self.known_topics: dict[str, Entity] = {}
        self.alias_map: dict[str, str] = {}           # alias -> canonical_name

    async def refresh_cache(self):
        """Load all entities into memory for fast matching."""
        all_entities = await self.entity_repo.list_all()
        for entity in all_entities:
            cache = getattr(self, f"known_{entity.entity_type}s", None)
            if cache is not None:
                cache[entity.normalized_name] = entity
                # Also index aliases
                for alias in entity.metadata.get("aliases", []):
                    self.alias_map[normalize_name(alias)] = entity.normalized_name

    def find_in_text(self, text: str) -> list[MatchedEntity]:
        """Find known entities mentioned in text."""
        text_lower = text.lower()
        matches = []

        # Check each known entity
        for normalized, entity in self.known_repos.items():
            # Check canonical name
            if self._word_boundary_match(entity.name.lower(), text_lower):
                matches.append(MatchedEntity(
                    entity=entity,
                    confidence=0.9,  # High confidence for exact match
                    match_type="keyword"
                ))
                continue

            # Check aliases
            for alias in entity.metadata.get("aliases", []):
                if self._word_boundary_match(alias.lower(), text_lower):
                    matches.append(MatchedEntity(
                        entity=entity,
                        confidence=0.85,
                        match_type="alias"
                    ))
                    break

        # Repeat for papers, tools, topics...
        return matches

    def _word_boundary_match(self, needle: str, haystack: str) -> bool:
        """Match with word boundaries to avoid partial matches."""
        import re
        pattern = r'\b' + re.escape(needle) + r'\b'
        return bool(re.search(pattern, haystack, re.IGNORECASE))
```

**Fuzzy matching for near-misses:**

```python
from Levenshtein import distance

def fuzzy_find_entity(name: str, known_entities: dict[str, Entity], max_distance: int = 2) -> Entity | None:
    """Find entity allowing for typos/variations."""
    normalized = normalize_name(name)

    # Exact match first
    if normalized in known_entities:
        return known_entities[normalized]

    # Fuzzy match
    for known_normalized, entity in known_entities.items():
        if distance(normalized, known_normalized) <= max_distance:
            return entity

    return None
```

**What this stage produces:**
- List of **confirmed entities** (high confidence, from keyword matching)
- List of **probable entities** (medium confidence, from fuzzy matching)
- Remaining content that needs LLM analysis

**What gets passed to LLM:**
- Only content segments without confirmed entity matches
- Pre-detected entities for validation/confidence scoring
- Request for topic extraction (which code cannot do)

### 8.4 Stage 3: LLM Entity Extraction (Expensive - Minimize Usage)

> **When to call LLM:**
> - Topic extraction (code cannot infer topics)
> - Validating low-confidence fuzzy matches
> - Resolving ambiguous entity mentions
>
> **When NOT to call LLM:**
> - Entity already detected via URL pattern (use that directly)
> - Entity matched via keyword/alias (high confidence)
> - Content is primarily promotional/low-value

**Optimized Prompt Template (includes pre-detected entities):**

```
You are an expert content analyst. Your primary job is TOPIC EXTRACTION.

CONTENT TYPE: {content_type}
CONTENT TITLE: {title}

## PRE-DETECTED ENTITIES (already found via URL/keyword matching)
The following entities were detected with high confidence - DO NOT re-extract these:
{pre_detected_entities_json}

## YOUR TASKS

1. TOPICS: Extract 3-7 hierarchical topics (this is your PRIMARY task)
   - Format: "Parent > Child > Grandchild" (e.g., "AI > LLMs > RAG")
   - Include both broad categories and specific concepts
   - PREFER existing topics over creating new ones

2. VALIDATE: For each pre-detected entity, confirm edge_type:
   - discusses: Primary subject of content
   - mentions: Referenced but not focus
   - uses: Demonstrated or used
   - cites: Academic citation

3. ADDITIONAL ENTITIES (only if missed by pre-detection):
   - Only extract repos/tools/papers NOT in pre-detected list
   - Must be substantively discussed, not just name-dropped

<CONTENT>
{content_text}
</CONTENT>

EXISTING TOPICS (strongly prefer these):
{existing_topics}

Respond in JSON format:
{
  "topics": [
    {"name": "AI > LLMs > RAG", "confidence": "high", "edge_type": "discusses"}
  ],
  "pre_detected_validations": [
    {"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": true}
  ],
  "additional_entities": [
    {"type": "repo", "name": "FAISS", "confidence": "medium", "edge_type": "mentions"}
  ]
}
```

**When to SKIP LLM entirely:**

```python
def should_skip_llm(content: Content, pre_detected: list[Entity]) -> bool:
    """Determine if LLM call can be skipped."""

    # Skip if content is too short (not enough for topics)
    if len(content.text) < 500:
        return True

    # Skip if content is primarily promotional
    if is_promotional_content(content):
        return True

    # Skip if we already have sufficient entities from pre-detection
    # AND content type doesn't benefit from topic extraction
    if len(pre_detected) >= 5 and content.content_type in ["changelog", "release_notes"]:
        return True

    return False
```

**LLM Cost Tracking:**

```python
@dataclass
class ExtractionMetrics:
    content_id: str
    pre_detected_count: int      # Entities found via code
    llm_extracted_count: int     # Entities found via LLM
    llm_skipped: bool            # Did we skip LLM?
    llm_tokens_used: int         # Token count if LLM called
    total_latency_ms: int

# Log for monitoring and optimization
# Goal: maximize pre_detected_count / minimize llm_tokens_used
```

### 8.5 Stage 4: Entity Resolution

For each extracted entity:

1. **Normalize the name**
2. **Check for existing entity** with matching `normalized_name` or alias
3. **If GitHub repo detected:**
   - Fetch metadata from GitHub API
   - Match to existing entity or create new
4. **If paper detected:**
   - Search arXiv/Semantic Scholar for metadata
   - Match to existing entity or create new
5. **If topic detected:**
   - Parse hierarchy ("AI > LLMs > RAG")
   - Ensure parent topics exist, create if needed
   - Link to existing or create new
6. **Create content-entity edge** with appropriate type

### 8.6 Stage 5: Metadata Fetching

**GitHub API:**
```python
async def fetch_github_repo(owner: str, repo: str) -> dict:
    """Fetch repository metadata from GitHub API."""
    url = f"https://api.github.com/repos/{owner}/{repo}"
    # Returns: name, description, stars, language, topics, html_url
```

**arXiv API:**
```python
async def fetch_arxiv_paper(arxiv_id: str) -> dict:
    """Fetch paper metadata from arXiv API."""
    url = f"http://export.arxiv.org/api/query?id_list={arxiv_id}"
    # Returns: title, authors, abstract, published, doi
```

**Semantic Scholar API (fallback for paper title search):**
```python
async def search_paper(title: str) -> dict:
    """Search for paper by title."""
    url = f"https://api.semanticscholar.org/graph/v1/paper/search?query={title}"
    # Returns: paperId, title, authors, abstract, arxivId, doi
```

### 8.7 Sponsored Content Filtering

For YouTube video descriptions, filter out:

```python
SPONSORED_PATTERNS = [
    r"bit\.ly/",
    r"amzn\.to/",
    r"geni\.us/",
    r"tinyurl\.com/",
    r"\?ref=",
    r"\?affiliate",
    r"utm_source=",
    r"sponsored",
    r"#ad\b",
    r"discount code",
]

SPONSORED_DOMAINS = [
    "amazon.com",  # Unless specifically about AWS
    "brilliant.org",
    "squarespace.com",
    "skillshare.com",
    "audible.com",
]

def is_sponsored_link(url: str, content_context: str) -> bool:
    """Determine if a URL is likely sponsored/affiliate."""
    # Check patterns
    # Cross-reference with transcript - is this actually discussed?
    # Return True if likely sponsored
```

## 9. Service Architecture

### 9.1 New Services

```
api/menos/services/
├── entity_extraction.py    # LLM-based extraction
├── entity_resolution.py    # Match/create entities
├── entity_fetchers/
│   ├── github.py           # GitHub API client
│   ├── arxiv.py            # arXiv API client
│   └── semantic_scholar.py # Semantic Scholar API client
├── url_detector.py         # Pattern-based URL detection
└── sponsored_filter.py     # Filter promotional content
```

### 9.2 EntityExtractionService

```python
class EntityExtractionService:
    """Extract entities from content using LLM."""

    def __init__(self, llm_provider: LLMProvider, entity_repo: EntityRepository):
        self.llm = llm_provider
        self.entity_repo = entity_repo

    async def extract_entities(
        self,
        content: str,
        content_type: str,
        title: str,
        existing_topics: list[str] | None = None,
    ) -> ExtractionResult:
        """Extract entities from content text."""
        # Build prompt with existing topics
        # Call LLM
        # Parse JSON response
        # Return structured ExtractionResult

    async def process_content(
        self,
        content_id: str,
        content_text: str,
        content_type: str,
        title: str,
        description_urls: list[str] | None = None,
    ) -> list[ContentEntityEdge]:
        """Full pipeline: extract, resolve, store."""
        # 1. Detect URLs in description
        # 2. Extract entities via LLM
        # 3. Resolve each entity
        # 4. Fetch external metadata
        # 5. Create edges
        # 6. Return created edges
```

### 9.3 EntityRepository

```python
class EntityRepository:
    """Database operations for entities."""

    async def find_by_normalized_name(
        self,
        normalized_name: str,
        entity_type: str | None = None
    ) -> Entity | None:
        """Find entity by normalized name."""

    async def find_by_alias(self, alias: str) -> Entity | None:
        """Find entity that has this alias."""

    async def create_entity(self, entity: Entity) -> Entity:
        """Create new entity."""

    async def create_edge(self, edge: ContentEntityEdge) -> ContentEntityEdge:
        """Create content-entity relationship."""

    async def get_entities_for_content(self, content_id: str) -> list[EntityWithEdge]:
        """Get all entities linked to content."""

    async def get_content_for_entity(self, entity_id: str) -> list[ContentWithEdge]:
        """Get all content linked to entity."""

    async def find_near_duplicates(self, max_distance: int = 1) -> list[list[Entity]]:
        """Find potential duplicate entities."""
```

## 10. API Changes

### 10.1 New Endpoints

```
# Entity CRUD
GET    /api/v1/entities                    # List entities (filterable by type)
GET    /api/v1/entities/{id}               # Get entity details
GET    /api/v1/entities/{id}/content       # Get content linked to entity
PATCH  /api/v1/entities/{id}               # Update entity (merge, rename)
DELETE /api/v1/entities/{id}               # Delete entity

# Entity Discovery
GET    /api/v1/entities/topics             # List topic hierarchy
GET    /api/v1/entities/repos              # List repositories
GET    /api/v1/entities/papers             # List papers
GET    /api/v1/entities/duplicates         # Get potential duplicates

# Content-Entity Relationships
GET    /api/v1/content/{id}/entities       # Get entities for content
POST   /api/v1/content/{id}/entities       # Manually add entity to content
DELETE /api/v1/content/{id}/entities/{eid} # Remove entity from content

# Reprocessing
POST   /api/v1/admin/reprocess             # Trigger entity extraction reprocessing
GET    /api/v1/admin/reprocess/status      # Get reprocessing status
```

### 10.2 Updated Graph Endpoint

```python
# GET /api/v1/graph now includes entities as nodes

{
  "nodes": [
    # Content nodes
    {"id": "content:abc", "type": "content", "title": "...", "content_type": "youtube"},
    # Entity nodes
    {"id": "entity:xyz", "type": "entity", "entity_type": "repo", "name": "LangChain"},
    {"id": "entity:123", "type": "entity", "entity_type": "topic", "name": "RAG", "hierarchy": ["AI", "LLMs", "RAG"]},
  ],
  "edges": [
    {"source": "content:abc", "target": "entity:xyz", "type": "uses"},
    {"source": "content:abc", "target": "entity:123", "type": "discusses"},
  ]
}
```

### 10.3 Updated Search

```python
# POST /api/v1/search now supports entity filtering

{
  "query": "how to build agents",
  "tags": ["python"],                    # Existing tag filter
  "entities": ["entity:langchain"],      # Filter by entity
  "entity_types": ["repo", "topic"],     # Filter by entity type
  "topics": ["AI > LLMs > Agents"],      # Filter by topic hierarchy
  "limit": 20
}
```

## 11. Configuration

### 11.1 Environment Variables

```bash
# Entity Extraction
ENTITY_EXTRACTION_ENABLED=true
ENTITY_EXTRACTION_PROVIDER=ollama        # ollama, openai, anthropic
ENTITY_EXTRACTION_MODEL=qwen3:latest

# API Keys for Metadata Fetching
GITHUB_TOKEN=ghp_xxx                     # Optional, increases rate limits
SEMANTIC_SCHOLAR_API_KEY=xxx             # Optional

# Extraction Limits
ENTITY_MAX_TOPICS_PER_CONTENT=7
ENTITY_MIN_CONFIDENCE=0.6                # 0.0-1.0
ENTITY_FETCH_EXTERNAL_METADATA=true
```

### 11.2 Provider Abstraction

```python
class EntityExtractionProvider(Protocol):
    """Protocol for entity extraction providers."""

    async def extract(
        self,
        content: str,
        content_type: str,
        title: str,
        existing_topics: list[str],
    ) -> ExtractionResult:
        """Extract entities from content."""
        ...

class OllamaEntityExtractor(EntityExtractionProvider):
    """Ollama-based entity extraction."""
    ...

class OpenAIEntityExtractor(EntityExtractionProvider):
    """OpenAI-based entity extraction."""
    ...
```

## 12. Migration & Reprocessing

### 12.1 Database Migration

```sql
-- New migration: add_entity_tables.surql

-- Entity table
DEFINE TABLE entity SCHEMAFULL;
-- ... (as defined in section 5.1)

-- Content-Entity edge table
DEFINE TABLE content_entity SCHEMAFULL;
-- ... (as defined in section 5.2)

-- Add processing status to content
DEFINE FIELD entity_extraction_status ON content TYPE option<string>;  -- pending, processing, completed, failed
DEFINE FIELD entity_extraction_at ON content TYPE option<datetime>;
```

### 12.2 Reprocessing Script

Extend `scripts/reprocess_content.py` to include entity extraction:

```python
async def reprocess_entities(self, content_id: str, dry_run: bool = False):
    """Extract and store entities for existing content."""
    # 1. Fetch content and transcript from MinIO
    # 2. Run entity extraction pipeline
    # 3. Store entities and edges
    # 4. Update content.entity_extraction_status
```

### 12.3 Reprocessing Strategy

1. **Mark all existing content** as `entity_extraction_status = "pending"`
2. **Process in batches** of 10-20 (LLM calls are slow)
3. **Rate limit** external API calls (GitHub: 5000/hour, arXiv: respectful delays)
4. **Track progress** in database for resumability
5. **Log extensively** for monitoring

## 13. Future Considerations

### 13.1 Embedding-Based Similarity Edges

Add edges between entities that frequently co-occur or have similar embeddings:

```sql
DEFINE TABLE entity_similarity SCHEMAFULL;
DEFINE FIELD entity_a ON entity_similarity TYPE record<entity>;
DEFINE FIELD entity_b ON entity_similarity TYPE record<entity>;
DEFINE FIELD similarity_score ON entity_similarity TYPE float;
DEFINE FIELD co_occurrence_count ON entity_similarity TYPE int;
```

### 13.2 Entity Relationship Inference

Use LLM to infer relationships between entities:
- "LangChain uses FAISS for vector storage"
- "Paper X cites Paper Y"
- "Tool A is an alternative to Tool B"

### 13.3 User Entity Corrections

Allow users to:
- Merge duplicate entities
- Rename entities
- Add aliases
- Correct entity types
- Remove false positives

### 13.4 Entity Freshness

Periodically re-fetch external metadata:
- GitHub stars/description may change
- Papers may get DOIs after initial arXiv publication
- Tools may be deprecated

### 13.5 Topic Taxonomy Management

- Pre-defined topic hierarchies for common domains
- User-contributed taxonomy extensions
- Automatic taxonomy refinement based on usage patterns

## 14. Implementation Phases

### Phase 1: Core Infrastructure
1. Database migrations for entity tables
2. Entity and ContentEntity models
3. EntityRepository with basic CRUD
4. Normalization utilities

### Phase 2: URL Detection
1. URL pattern detection for GitHub, arXiv, DOI
2. Sponsored content filtering
3. GitHub API client
4. arXiv API client

### Phase 3: LLM Extraction
1. EntityExtractionService with Ollama provider
2. Prompt templates
3. JSON parsing and validation
4. Integration with ingestion pipeline

### Phase 4: Entity Resolution
1. Matching logic with normalization
2. Alias support
3. Hierarchy management for topics
4. Duplicate detection

### Phase 5: API & Reprocessing
1. Entity API endpoints
2. Updated graph endpoint
3. Updated search with entity filters
4. Reprocessing script extension

### Phase 6: Polish
1. Near-duplicate cleanup tools
2. Entity merge functionality
3. Monitoring and logging
4. Documentation

## 15. Open Questions

1. **Topic taxonomy seeding**: Should we pre-populate common topic hierarchies, or let them emerge organically?

2. **Confidence thresholds**: What's the right balance between recall (extract everything) and precision (only high-confidence entities)?

3. **External API rate limits**: How do we handle GitHub/arXiv rate limits during bulk reprocessing?

4. **Entity deduplication UI**: Do we need a user-facing interface for managing duplicates, or is API-only sufficient for v1?

5. **Cross-content entity inference**: If Video A mentions "that transformer paper" without naming it, can we infer it from context of other videos?

---

## 16. Future Refinements (Backlog)

> Refinements identified during knowledge base review, deferred to future phases.
> Originally tracked in `entity-extraction-future-refinements.md`, consolidated here.

### 16.1 Architecture Refinements

**Orchestrator Pattern** (see also [docs/specs/orchestrator.md](orchestrator.md)):
Use tool-less reasoning agents for LLM extraction to prevent nested deadlock:

```python
# Coordinator has all data tools
entity_coordinator = Agent(
    model='anthropic:claude-3-5-sonnet',
    tools=[fetch_content, fetch_urls, search_existing_entities, store_entity]
)

# Tool-less reasoning agents (no tools = no deadlock risk)
entity_analyzer = Agent(model='haiku', system_prompt="Extract entities...")
topic_hierarchizer = Agent(model='haiku', system_prompt="Build topic hierarchies...")
```

**Message Bus Integration** (see also [docs/specs/message-bus.md](message-bus.md)):
Queue-based async processing using Celery with task queues:
- `entity_extraction_queue` - LLM-based extraction (slower)
- `entity_metadata_queue` - External API calls (rate-limited)
- `entity_resolution_queue` - Normalization + DB lookups (fast)

**Working Memory for Extraction State:**
Store extraction progress in database for resumability via `entity_extraction_progress` field on content.

### 16.2 New Entity Types

**Insights** (from [docs/research/evermemos-inspiration.md](../research/evermemos-inspiration.md)):
Atomic, independently-searchable learnings from content (e.g., "Dependency injection enables swapping implementations").

**Techniques** (from [docs/backlog/discussions-needed.md](../backlog/discussions-needed.md)):
Actionable methods matchable to projects (e.g., "Semantic Chunking" with prerequisites, alternatives, difficulty).

### 16.3 Recommendation Engine Integration

See also [docs/specs/recommendation-engine.md](recommendation-engine.md).

- **Entity-aware preference vectors**: Track user affinity per entity, update on content ratings
- **Multi-signal scoring**: Add `w_entity * entity_match_score` to recommendation formula
- **Entity-based cold-start**: Bootstrap recommendations from entities when ratings are sparse

### 16.4 Memory Type Taxonomy

Map entities to EverMemOS 7-type taxonomy via `memory_category` field:

| Entity Type | Memory Category |
|-------------|-----------------|
| topic | semantic_knowledge |
| insight | semantic_knowledge OR fact |
| repo | profile |
| paper | semantic_knowledge |
| tool | profile |
| person | profile |

### 16.5 Search Enhancements

- **Multi-round recall**: Exact entity match → related entities → LLM-guided refinement
- **Entity embeddings**: Add 1024-dim embeddings to entities for semantic entity search

### 16.6 Prompt Engineering Improvements

- **Verbalized sampling**: Request 3-5 alternative entity sets with probabilities
- **Multi-stage prompting**: Quality assessment → extraction → verification
- **Model hierarchy**: Orchestrator (Sonnet) → Extraction (Haiku) → Synthesis (Sonnet)

### 16.7 Scalability

- **Rate limit tracking in Redis**: Shared across workers
- **Incremental metadata updates**: Only re-fetch entities older than 7 days
- **Batch processing with deduplication**: Reduce DB roundtrips during reprocessing

### 16.8 UI Considerations

See also [docs/specs/ui-roadmap.md](ui-roadmap.md).

- **Entity sidebar**: Entities from current conversation, related content, quick actions
- **Topic hierarchy navigation**: Breadcrumb "AI → LLMs → RAG" with clickable levels
- **Graph visualization**: Color by type, size by mentions, cluster by hierarchy

### 16.9 Backlog Priority Order

| Phase | Refinements |
|-------|-------------|
| **Phase 2** | Message bus integration, async processing |
| **Phase 3** | Entity embeddings, preference learning |
| **Phase 4** | Insights entity type, techniques entity type |
| **Phase 5** | UI integration (sidebar, graph enhancements) |
| **Phase 6** | Multi-round recall, model hierarchy |
