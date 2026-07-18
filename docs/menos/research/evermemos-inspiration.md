# EverMemOS: Memory System Patterns for menos

Analysis of EverMemOS (enterprise-grade AI memory system) and patterns applicable to menos.

---

## Architecture Comparison

### EverMemOS: Two Cognitive Tracks

```
┌─────────────────────────────────────┐
│       Memory Construction           │
├─────────────────────────────────────┤
│ • MemCell extraction (atomic units) │
│ • Multi-level hierarchical org      │
│ • 7 memory types                    │
│ • Theme + participant grouping      │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│        Memory Perception            │
├─────────────────────────────────────┤
│ • Hybrid retrieval (RRF fusion)     │
│ • Intelligent reranking             │
│ • LLM-guided multi-round recall     │
│ • Lightweight fast mode             │
└─────────────────────────────────────┘
```

### menos: Content Pipeline

```
┌─────────────────────────────────────┐
│       Content Ingestion             │
├─────────────────────────────────────┤
│ • YouTube transcripts               │
│ • Webpages via API                  │
│ • Archive-first preservation        │
│ • Semantic embeddings (Ollama)      │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│       Analysis Layer                │
├─────────────────────────────────────┤
│ • Tagging                           │
│ • Summarization                     │
│ • Metadata enrichment               │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│    Search + Phase 5 Agentic         │
├─────────────────────────────────────┤
│ • Semantic search (SurrealDB)       │
│ • Preference learning               │
│ • Application suggester (planned)   │
└─────────────────────────────────────┘
```

---

## Feature-by-Feature Comparison

| Feature | EverMemOS | menos |
|---------|-----------|-------|
| **Primary Focus** | Conversation memory | Content knowledge |
| **Memory Types** | 7 distinct types | Content + metadata |
| **Atomic Units** | MemCells from conversations | None yet (opportunity) |
| **Organization** | Hierarchical by theme/participant | Flat with metadata tags |
| **Retrieval** | Hybrid RRF + LLM reranking | Semantic + metadata filters |
| **Profile Model** | Living profiles (continuous update) | Static (opportunity) |
| **Proactive Recall** | Evidence-based perception | Application Suggester (planned) |
| **Data Preservation** | Not emphasized | Archive-first (strength) |
| **Embedding Strategy** | Single vector | Dual planned (global + chunk) |

---

## Where EverMemOS Excels

### 1. Memory Type Taxonomy
Their 7 types provide semantic structure:
- **Episodes**: Time-bound events/experiences
- **Profiles**: Entity descriptions
- **Preferences**: Likes, dislikes, interests
- **Relationships**: Connections between entities
- **Semantic Knowledge**: Concepts and understanding
- **Facts**: Discrete true statements
- **Core Memories**: Foundational, high-importance items

### 2. MemCell Extraction
Atomic memory units extracted from content:
- Each MemCell is independently searchable
- Maintains back-reference to source
- Enables fine-grained retrieval

### 3. Hierarchical Organization
Memories grouped by:
- Theme (what it's about)
- Participants (who's involved)
- Temporal relationship (when it happened)

### 4. LLM-Guided Recall
When initial retrieval is insufficient:
- LLM analyzes gaps
- Generates refined queries
- Multi-round search until satisfied

---

## Where menos Excels

### 1. Archive-First Pipeline
```
Fetch expensive data → Archive immediately → Then process
```
- Never lose raw data (API changes, rate limits)
- Enables reprocessing with different strategies
- Tracks costs over time

### 2. Content-Centric Design
- Focus on external knowledge (videos, blogs, papers)
- Not conversation memory
- Better for research assistant use case

### 3. Simpler Stack
- SurrealDB handles vector + metadata + queries
- MinIO for file storage
- Single database vs their 4 (Milvus + Elasticsearch + MongoDB + Redis)

---

## High-Value Ideas to Borrow

### 1. Insight Extraction Pattern (HIGHEST VALUE)

**What They Do**:
EverMemOS extracts atomic "MemCells" from conversations - discrete, searchable units of memory.

**How to Adapt for menos**:
Extract atomic "Insights" or "Learnings" from content after tagging.

```python
# Current pipeline:
Content → Tags → Summary → Store

# Enhanced pipeline:
Content → Tags → Summary → Insights → Store
```

**Example**:
```python
# Input: YouTube video transcript about dependency injection

# Output insights:
[
    {
        "insight": "Dependency injection enables swapping implementations without touching consuming code",
        "type": "semantic_knowledge",
        "confidence": 0.92,
        "source_timestamp": "12:34",
        "applicable_to": ["testing", "modularity", "architecture"]
    },
    {
        "insight": "Protocol classes in Python define interfaces without implementation",
        "type": "fact",
        "confidence": 0.95,
        "source_timestamp": "15:20",
        "applicable_to": ["python", "typing", "contracts"]
    }
]
```

**Implementation for menos**:
- Add insight extraction step to YouTube ingestion pipeline
- Store insights as separate SurrealDB records with back-reference to source
- Enable fine-grained search: "Find insights about testing patterns"

---

### 2. Seven Memory Types Taxonomy

**How to Adapt for Content**:

| EverMemOS Type | menos Equivalent | Example |
|----------------|------------------|---------|
| Episodes | `watch_history` | "Watched video on 2025-01-15" |
| Profiles | `source_profiles` | "Channel: AI educator, practical focus" |
| Preferences | `topic_preferences` | "Interested in multi-agent systems (5/5)" |
| Relationships | `content_connections` | "Video X inspired project Y" |
| Semantic Knowledge | `learned_concepts` | "Dependency injection pattern" |
| Facts | `content_metadata` | "Video duration: 30:45" |
| Core Memories | `foundational_content` | "Must-watch for AI agents" |

**Schema Extension**:
```python
# Add to SurrealDB content model
{
    "memory_type": "semantic_knowledge",  # One of 7 types
    "source_content_id": "youtube:abc123",
    "extracted_insight": "...",
    "connections": ["project:menos", "tag:agents"],
    "importance": "high",  # For core memories
}
```

---

### 3. LLM-Guided Multi-Round Recall

**What They Do**:
When initial retrieval is insufficient, LLM analyzes gaps and generates refined queries.

**How to Adapt for menos**:
Add to search pipeline for Phase 5:

```python
async def smart_search(query: str, min_results: int = 5) -> list[Content]:
    # Round 1: Standard search
    results = await semantic_search(query)

    if len(results) >= min_results:
        return results

    # Round 2: LLM refinement
    refined_queries = await llm_refine_query(
        original_query=query,
        current_results=results,
        prompt="What alternative phrasings or related concepts should we search for?"
    )

    for refined in refined_queries:
        more_results = await semantic_search(refined)
        results.extend(more_results)
        if len(results) >= min_results:
            break

    return dedupe(results)
```

**When to Use**:
- Complex queries with poor initial results
- Application Suggester scenarios
- NOT for simple lookups (use fast mode)

---

### 4. Living Profile / Preference Evolution

**What They Do**:
User profiles dynamically evolve with each interaction.

**Current menos State**:
Preferences would be static - built from rated content.

**Enhancement**:
Update preference vectors incrementally after each rating:

```python
async def update_preferences_on_rating(
    content_id: str,
    rating: int
):
    # Get content embedding
    content_vec = await get_content_embedding(content_id)

    # Get current preference vector
    prefs = await get_user_preferences()

    # Weighted update based on rating
    # High rating (5) = strong positive influence
    # Low rating (1) = negative influence
    weight = (rating - 3) / 10  # -0.2 to +0.2

    new_pref_vec = normalize(
        prefs.vector + (weight * content_vec)
    )

    await update_preferences(new_pref_vec)
```

**Benefits**:
- Preferences evolve naturally
- No need for explicit preference management
- Better recommendations over time

---

## Medium-Value Ideas

### 5. Hierarchical Content Clustering

Cluster content by topic using embeddings:

```python
# Periodic clustering job
clusters = cluster_content_by_embedding(
    collection="content",
    min_cluster_size=5
)

# Result: Theme groups
# - "Multi-agent systems" (15 videos)
# - "Prompt engineering" (8 articles)
# - "Python patterns" (12 items)
```

**Use Cases**:
- "What themes has this creator been covering?"
- "Show me everything about caching"
- Auto-generate topic pages

### 6. Intelligent Reranking

Post-retrieval reranking using preference similarity:

```python
def rerank_by_preferences(results: list, pref_vec: list) -> list:
    for r in results:
        # Boost items matching user taste
        pref_similarity = cosine_sim(r.vector, pref_vec)
        # Combine with original score
        r.final_score = r.search_score * 0.7 + pref_similarity * 0.3

    return sorted(results, key=lambda x: x.final_score, reverse=True)
```

---

## What NOT to Borrow

| Skip This | Reason |
|-----------|--------|
| **MongoDB + Elasticsearch + Milvus + Redis** | Overkill for single-user. SurrealDB handles it. |
| **Full agentic retrieval for every query** | LLM in loop is expensive. Use only when needed. |
| **Their evaluation framework** | LoCoMo is for conversation memory, not content. |
| **Conversation-centric data model** | menos is content knowledge, not chat history. |

---

## Priority Ranking for menos

| Priority | Idea | Effort | Value |
|----------|------|--------|-------|
| 1 | Insight extraction | Medium | High |
| 2 | 7 memory types taxonomy | Low | Medium |
| 3 | Living preference evolution | Low | Medium |
| 4 | LLM-guided recall | Medium | Medium |
| 5 | Hierarchical clustering | Medium | Low |
| 6 | Intelligent reranking | Low | Low |

**Recommendation**: Start with #1 (Insight extraction) - it's the most novel and valuable addition to menos's content pipeline.

---

## Integration Roadmap for menos

### Phase 1: Foundation (With Current menos)
- Add memory_type field to content model
- Start categorizing ingested content by type
- No code changes needed, just metadata enrichment

### Phase 2: Insight Extraction (Phase 5 Prep)
- Add insight extraction step to ingestion pipeline
- Store insights as separate SurrealDB records
- Enable insight-specific search endpoint

### Phase 3: Dynamic Preferences
- Implement preference vector updates on ratings
- Add preference-weighted reranking to search
- Track preference evolution over time

### Phase 4: LLM-Guided Search
- Implement multi-round recall for complex queries
- Add to Phase 5 agentic search capability
- Use sparingly (cost consideration)
