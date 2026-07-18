# Agentic Search Architecture (Phase 5)

Architecture specification for menos Phase 5: intelligent, self-evolving agentic search over the content vault.

---

## 1. Problem Statement

### Current Limitations

**Context Window Bloat**
- Traditional agent approaches load all tool definitions upfront (150K+ tokens)
- Intermediate data flows through LLM context repeatedly
- Expensive and hits context limits quickly

**Stateless Operations**
- Each tool call is independent
- Large datasets must be passed through context
- No persistent working memory

**Limited Adaptability**
- Fixed set of tools and capabilities
- Cannot learn from experience
- No capability to create new specialized tools

### Why This Matters for menos

menos already has:
- SurrealDB with content + chunk embeddings
- MinIO with raw content storage
- Ollama for embeddings and summaries
- YouTube ingestion pipeline

Phase 5 adds intelligence on top - the ability to:
- Orchestrate complex multi-step queries
- Learn user preferences over time
- Suggest applicable content for projects
- Self-improve through learned patterns

---

## 2. Solution Overview

A **coordinator agent** that:

1. Uses **working memory** (SurrealDB + application state) instead of context bloat
2. Writes **code to orchestrate queries** instead of tool-heavy approaches
3. **Progressively discovers** capabilities as needed
4. **Delegates to specialized sub-agents** with isolated contexts
5. Follows the **tool-less sub-agent pattern** (see `knowledge/lessons/nested-agent-deadlock.md`)

---

## 3. Core Architecture

### High-Level Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Coordinator Agent                         │
│  - Minimal context (~4K tokens)                             │
│  - Has data-fetching tools only                             │
│  - Orchestrates via tool-less sub-agents                    │
└─────────────────────────────────────────────────────────────┘
                            │
                            │ Tools (data fetching)
        ┌───────────────────┼───────────────────┐
        │                   │                   │
        ▼                   ▼                   ▼
┌──────────────┐    ┌──────────────┐   ┌──────────────┐
│ SurrealDB    │    │ MinIO        │   │ Ollama       │
│ Queries      │    │ Retrieval    │   │ Embeddings   │
├──────────────┤    ├──────────────┤   ├──────────────┤
│ - Content    │    │ - Transcripts│   │ - Query vec  │
│ - Chunks     │    │ - Metadata   │   │ - Summaries  │
│ - Prefs      │    │ - Files      │   │              │
└──────────────┘    └──────────────┘   └──────────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│              Tool-less Reasoning Sub-Agents                  │
│  (NO tools - pure LLM reasoning only)                       │
├─────────────────────────────────────────────────────────────┤
│  - Content Analyzer (tagging, summarization)                │
│  - Recommendation Reasoner (preference matching)            │
│  - Application Suggester (technique → project matching)     │
│  - Synthesis Agent (multi-source aggregation)               │
└─────────────────────────────────────────────────────────────┘
```

### Critical Constraint: Tool-less Sub-Agents

**NEVER call an agent with tools from within another agent's tool.**

This causes event loop deadlocks. See `knowledge/lessons/nested-agent-deadlock.md`.

**Correct Pattern:**
```python
# Coordinator has ALL data-fetching tools
@coordinator.tool
async def fetch_content(content_id: str) -> dict:
    """Coordinator fetches data from SurrealDB"""
    return await surrealdb.query(f"SELECT * FROM content WHERE id = '{content_id}'")

@coordinator.tool
async def analyze_content(data: dict) -> dict:
    """Delegate reasoning to tool-less agent"""
    # content_analyzer has NO tools - just reasoning
    result = await content_analyzer.run(
        f"Analyze this content and generate tags:\n{data}"
    )
    return {"analysis": result.output}

# Tool-less reasoning agent
content_analyzer = Agent(
    model='anthropic:claude-3-5-haiku',
    system_prompt="You are a content analysis specialist...",
    # NO @agent.tool decorators - pure reasoning
)
```

---

## 4. Coordinator Agent

### Responsibility
High-level orchestration and decision-making for complex queries.

### Tools Available (Data Fetching Only)

```python
# SurrealDB queries
search_content(query: str, limit: int) -> list[dict]
get_content_by_id(content_id: str) -> dict
get_chunks_for_content(content_id: str) -> list[dict]
search_chunks(query_embedding: list[float], limit: int) -> list[dict]

# MinIO retrieval
get_transcript(content_id: str) -> str
get_metadata(content_id: str) -> dict

# Ollama
generate_embedding(text: str) -> list[float]
generate_summary(text: str, max_length: int) -> str

# Sub-agent delegation (tool-less agents)
analyze_content(data: dict) -> dict
generate_recommendations(context: dict) -> list[dict]
suggest_applications(content: dict, project: dict) -> list[dict]
synthesize_results(results: list[dict], query: str) -> str
```

### Context Budget

- System prompt: ~1K tokens
- Tool definitions: ~500 tokens (data tools only)
- Conversation history: ~2K tokens
- **Total: ~4K tokens** (vs 150K traditional)

### Implementation

```python
from pydantic_ai import Agent

coordinator = Agent(
    model='anthropic:claude-3-5-sonnet',
    system_prompt="""You are an intelligent search coordinator for a content vault.

    You have access to:
    1. SurrealDB for content and embeddings
    2. MinIO for raw content retrieval
    3. Ollama for embeddings and summaries
    4. Specialized reasoning agents (tool-less)

    Workflow:
    1. Understand the user's query intent
    2. Fetch relevant data using your tools
    3. Delegate reasoning to specialized agents
    4. Synthesize and return results

    When you have the final answer:
    - FINAL(answer) - return simple text answer
    - FINAL_VAR(variable_name) - return complex structured data
    """,
    deps_type=CoordinatorDeps,
)
```

---

## 5. Tool-less Sub-Agents

### Content Analyzer
```python
content_analyzer = Agent(
    model='anthropic:claude-3-5-haiku',
    system_prompt="""You are a content analysis specialist.

    Given content (transcript, article, etc.), you:
    - Extract key topics and themes
    - Generate relevant tags
    - Identify actionable techniques
    - Assess content quality and relevance

    Return structured analysis as JSON.
    """,
    # NO TOOLS
)
```

### Recommendation Reasoner
```python
recommendation_reasoner = Agent(
    model='anthropic:claude-3-5-haiku',
    system_prompt="""You are a recommendation specialist.

    Given:
    - User preferences (topics, ratings, history)
    - Candidate content items
    - Current context/query

    You:
    - Score relevance of each item
    - Explain why items match preferences
    - Rank recommendations

    Return ranked list with explanations.
    """,
    # NO TOOLS
)
```

### Application Suggester
```python
application_suggester = Agent(
    model='anthropic:claude-3-5-sonnet',  # Use better model for complex reasoning
    system_prompt="""You are an application suggestion specialist.

    Given:
    - Techniques/insights from content
    - Project context (goals, challenges, tech stack)

    You:
    - Match techniques to project needs
    - Explain how to apply each technique
    - Prioritize by impact and feasibility

    Return actionable suggestions with implementation guidance.
    """,
    # NO TOOLS
)
```

### Synthesis Agent
```python
synthesis_agent = Agent(
    model='anthropic:claude-3-5-sonnet',
    system_prompt="""You are a synthesis specialist.

    Given:
    - Multiple search results
    - Original query
    - Context

    You:
    - Combine information from multiple sources
    - Resolve contradictions
    - Create coherent summary
    - Cite sources appropriately

    Return synthesized answer with citations.
    """,
    # NO TOOLS
)
```

---

## 6. Data Flow Examples

### Example: Complex Search Query

```
User: "What techniques for improving RAG retrieval have been discussed in recent videos?"

1. Coordinator: Parse intent
   - Topic: RAG retrieval improvement
   - Content type: videos
   - Time: recent

2. Coordinator: Generate query embedding
   └─> generate_embedding("RAG retrieval improvement techniques")
   └─> Returns: [0.123, 0.456, ...]

3. Coordinator: Search chunks
   └─> search_chunks(embedding, limit=50)
   └─> Returns: 50 relevant chunks from various videos

4. Coordinator: Group by content, get metadata
   └─> For each unique content_id:
       └─> get_content_by_id(content_id)
   └─> Returns: 12 unique videos with metadata

5. Coordinator: Delegate analysis to tool-less agent
   └─> analyze_content({"chunks": chunks, "metadata": metadata})
   └─> Content Analyzer extracts techniques:
       - "Use hybrid search (BM25 + semantic)"
       - "Rerank with cross-encoder"
       - "Chunk by semantic boundaries, not fixed size"

6. Coordinator: Synthesize results
   └─> synthesize_results(techniques, original_query)
   └─> Synthesis Agent creates coherent answer with citations

7. Coordinator: Return
   └─> FINAL(synthesized_answer)

Token Usage:
- Coordinator context: ~4K tokens
- Sub-agent calls: 3 × ~3K = 9K tokens (temporary)
- Total: ~13K tokens
- vs Monolithic: 100K+ tokens (all transcripts in context)
```

### Example: Application Suggester

```
User: "How can I apply learnings from my saved content to the menos project?"

1. Coordinator: Get project context
   └─> (Project context injected or fetched)
   └─> menos: content vault, SurrealDB, semantic search, Phase 5 agentic

2. Coordinator: Search for relevant techniques
   └─> search_content("implementation patterns techniques", limit=20)
   └─> search_chunks(project_embedding, limit=50)

3. Coordinator: Extract techniques
   └─> analyze_content(search_results)
   └─> Techniques found:
       - "Tool-less sub-agent pattern" (from AI videos)
       - "RRF hybrid search" (from RAG content)
       - "Living preference vectors" (from EverMemOS analysis)

4. Coordinator: Match to project
   └─> suggest_applications(techniques, project_context)
   └─> Application Suggester returns:
       - "Tool-less pattern → Phase 5 coordinator design (HIGH)"
       - "RRF hybrid → search endpoint improvement (MEDIUM)"
       - "Living vectors → preference learning (MEDIUM)"

5. Coordinator: Return ranked suggestions
   └─> FINAL_VAR(suggestions)
```

---

## 7. Design Decisions

### Why Tool-less Sub-Agents?

| Option | Pros | Cons |
|--------|------|------|
| Nested agents with tools | More autonomous | **Deadlocks** |
| Direct function calls | Simple, no deadlock | Loses modularity |
| **Tool-less sub-agents** | Clean separation, no deadlock | Coordinator has more tools |

**Decision**: Tool-less sub-agents - best balance of modularity and safety.

### Why Coordinator Has All Data Tools?

- **Separation of concerns**: Data fetching vs reasoning
- **No deadlocks**: Sub-agents can't trigger nested tool calls
- **Caching**: Coordinator can cache fetched data across sub-agent calls
- **Observability**: All data access through one point

### Model Selection Strategy

| Component | Model | Rationale |
|-----------|-------|-----------|
| Coordinator | Sonnet | Orchestration quality critical |
| Content Analyzer | Haiku | Simple, focused task |
| Recommendation Reasoner | Haiku | Scoring/ranking task |
| Application Suggester | Sonnet | Complex reasoning |
| Synthesis Agent | Sonnet | Quality matters for output |

**Cost optimization**: Route 70% of work to Haiku, reserve Sonnet for complex reasoning.

---

## 8. Integration with menos

### FastAPI Router

```python
from fastapi import APIRouter
from menos.services.agentic import CoordinatorService

router = APIRouter(prefix="/api/v1/agentic", tags=["agentic"])

@router.post("/search")
async def agentic_search(request: AgenticSearchRequest):
    """Complex search with multi-step reasoning"""
    coordinator = CoordinatorService()
    result = await coordinator.search(
        query=request.query,
        context=request.context
    )
    return result

@router.post("/recommend")
async def get_recommendations(request: RecommendationRequest):
    """Preference-aware recommendations"""
    coordinator = CoordinatorService()
    result = await coordinator.recommend(
        preferences=request.preferences,
        context=request.context
    )
    return result

@router.post("/suggest")
async def suggest_applications(request: ApplicationRequest):
    """Suggest content applications for project"""
    coordinator = CoordinatorService()
    result = await coordinator.suggest(
        project=request.project,
        content_ids=request.content_ids
    )
    return result
```

### Service Layer

```python
class CoordinatorService:
    def __init__(self):
        self.db = SurrealDBRepository()
        self.storage = MinIOStorage()
        self.embeddings = OllamaEmbeddings()
        self.coordinator = create_coordinator_agent()

    async def search(self, query: str, context: dict) -> AgenticResult:
        deps = CoordinatorDeps(
            db=self.db,
            storage=self.storage,
            embeddings=self.embeddings
        )
        result = await self.coordinator.run(
            f"Search for: {query}\nContext: {context}",
            deps=deps
        )
        return AgenticResult(
            answer=result.output,
            sources=result.metadata.get("sources", []),
            reasoning=result.metadata.get("reasoning", "")
        )
```

---

## 9. Success Metrics

### Token Efficiency
- **Baseline**: Traditional approach = 150K initial + data through context
- **Target**: <5K initial + data in storage (95%+ reduction)

### Context Usage Per Query
- **Baseline**: 50K tokens per complex query
- **Target**: 15K tokens per query (70% reduction)

### Query Quality
- Relevant results in top 5: 80%+
- User satisfaction with recommendations: 85%+
- Application suggestions acted upon: 50%+

---

## 10. Implementation Phases

### Phase 5.1: Core Coordinator
- Basic coordinator agent with SurrealDB tools
- Simple search orchestration
- No sub-agents yet (direct LLM reasoning)

### Phase 5.2: Tool-less Sub-Agents
- Add content analyzer sub-agent
- Add synthesis sub-agent
- Multi-step query support

### Phase 5.3: Recommendations
- Add recommendation reasoner
- Preference vector integration
- Learning from ratings

### Phase 5.4: Application Suggester
- Add application suggester sub-agent
- Project context modeling
- Technique extraction and matching

### Phase 5.5: Self-Improvement
- Pattern recognition in queries
- Learned query optimizations
- Performance tracking and tuning

---

## 11. References

- `knowledge/lessons/nested-agent-deadlock.md` - Critical architecture constraint
- `knowledge/research/recursive-language-models.md` - Academic validation
- `knowledge/specs/recommendation-engine.md` - Embedding and retrieval design
- `knowledge/external-analysis/evermemos-inspiration.md` - Memory patterns
- [Pydantic AI Documentation](https://ai.pydantic.dev/)
- [Anthropic: Code Execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
