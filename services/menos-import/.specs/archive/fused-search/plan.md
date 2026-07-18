---
created: 2026-02-11
completed:
started: 2026-02-12
---

# Team Plan: Fused SQL+Vector Search

## Objective

Add structured filter support (tags, quality tier, content_type) to both basic vector search and agentic search endpoints. Enable users to combine semantic similarity with metadata filters for precise content retrieval.

## Project Context

- **Language**: Python 3.12+ (FastAPI, Pydantic, SurrealDB)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Key files**:
  - `api/menos/services/storage.py` — SurrealDB repository
  - `api/menos/routers/search.py` — Search endpoints
  - `api/menos/services/agent.py` — Agentic search service
  - `api/menos/models.py` — Pydantic models

## Background

Current state:
- Basic vector search (`POST /api/v1/search`) supports `tags` and `content_type` filters via WHERE clauses
- Agentic search (`POST /api/v1/search/agentic`) does NOT pass any structured filters to vector queries
- No quality tier filtering exists yet (tier field not in schema)

Target state:
- Both endpoints accept `tier_min` parameter (S/A/B/C/D quality tier)
- Tier filter uses `WHERE tier IN $valid_tiers` where valid_tiers is computed from tier_min
- Tags filter uses `CONTAINSANY` (match any provided tag)
- Agent service passes filters through to all sub-queries during retrieval stage
- Router/API layer strictly validates `tier_min` to `S/A/B/C/D` and normalizes case
- When `tier_min` is provided, records with `tier = NULL` are excluded

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Add tier field + migration | 2 | Schema + migration | Sonnet | builder |
| T2: Storage layer tier filtering | 2 | Modify + test | Sonnet | builder |
| T3: Search router tier param | 2 | Modify + test | Sonnet | builder |
| T4: Agent service filter passthrough | 2 | Modify + test | Sonnet | builder |
| V1: Integration test suite | 2 | New test file | Sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| Schema Builder | builder | Sonnet 4.5 | Add tier field, write migration |
| Storage Builder | builder | Sonnet 4.5 | Implement tier filtering in storage layer |
| Router Builder | builder | Sonnet 4.5 | Add tier_min to SearchQuery/AgenticSearchQuery models |
| Agent Builder | builder | Sonnet 4.5 | Pass filters to agent service sub-queries |
| Test Builder | builder | Sonnet 4.5 | Write integration tests for filtered search |

## Execution Waves

### Wave 1: Schema & Storage Layer
**Dependencies**: None

- **T1: Add tier field to content table** [Sonnet] — Schema Builder
  - Add `tier` field to `ContentMetadata` model in `api/menos/models.py` (type: `str | None`, values: S/A/B/C/D)
  - Create migration in `api/migrations/` to add `tier` field to content table (nullable, default None)
  - Update `.claude/rules/schema.md` to document tier field

  **Acceptance Criteria**:
  - ContentMetadata model has `tier: str | None = None` field
  - Migration file exists with `DEFINE FIELD tier ON content TYPE option<string>`
  - Schema docs updated with tier field description

- **T2: Implement tier filtering in storage** [Sonnet] — Storage Builder
  - Current vector search in `agent.py` and `search.py` has WHERE clause with embedding checks
  - Add helper function `_compute_valid_tiers(tier_min: str | None) -> list[str]` to return tiers >= tier_min
  - Modify vector search queries in both files to accept optional `tier_min` parameter
  - Add `AND content_id.tier IN $valid_tiers` to WHERE clauses when tier_min provided
  - Keep internal service logic defensive for invalid/None inputs (no crash, safe no-filter behavior when unset)
  - Write unit tests for tier filtering logic

  **Acceptance Criteria**:
  - Helper function returns correct tier lists (e.g., tier_min="B" returns ["S", "A", "B"])
  - Vector search queries in agent.py and search.py accept tier_min parameter
  - WHERE clauses include tier filtering when tier_min is provided, excluding `tier = NULL` records in that case
  - Internal service behavior remains defensive for invalid/None inputs
  - Unit tests verify tier filter logic for all tier levels (S/A/B/C/D)

### Wave 2: API Layer Integration
**Dependencies**: [T1, T2]

- **T3: Add tier_min to search request models** [Sonnet] — Router Builder
  - Add `tier_min: str | None = None` to `SearchQuery` model in `api/menos/routers/search.py`
  - Add `tier_min: str | None = None` to `AgenticSearchQuery` model
  - Add strict API validation for `tier_min` (only S/A/B/C/D) with case normalization to uppercase
  - Pass tier_min parameter to storage/agent service calls
  - Update endpoint docstrings to document tier filtering

  **Acceptance Criteria**:
  - SearchQuery model has tier_min field with strict validation (must be S/A/B/C/D if provided) and uppercase normalization
  - AgenticSearchQuery model has the same strict validation and normalization behavior
  - Parameters passed through to backend services
  - Docstrings explain tier filtering behavior

- **T4: Pass filters through agent service** [Sonnet] — Agent Builder
  - Modify `AgentService.search()` to accept `tier_min` parameter
  - Pass tier_min to each vector search call in the multi-query retrieval loop (around line 200-215 in agent.py)
  - Update `_execute_vector_search()` helper to accept and use tier_min
  - Write unit tests for agent service filter propagation

  **Acceptance Criteria**:
  - AgentService.search() accepts tier_min parameter
  - All vector searches during retrieval stage include tier filtering
  - Unit tests verify filters propagate to all sub-queries
  - Mock tests confirm tier_min passed to storage layer

### Wave 3: Validation
**Dependencies**: [T1, T2, T3, T4]

- **V1: Integration test suite** [Sonnet] — Test Builder
  - Create `api/tests/integration/test_fused_search.py`
  - Test basic vector search with tier filtering
  - Test agentic search with tier filtering
  - Test combined filters (tier + tags + content_type)
  - Test edge cases (invalid tier rejected at API layer, no results, etc.)
  - Verify results respect tier boundaries

  **Acceptance Criteria**:
  - Integration tests cover both search endpoints
  - Tests verify tier filtering works correctly (tier_min="A" excludes B/C/D content)
  - Combined filter tests (tier + tags) pass
  - Edge case tests pass, including invalid `tier_min` request validation
  - All tests pass with `uv run pytest tests/integration/test_fused_search.py -v`

## Dependency Graph

```
T1 (Schema) ─┐
             ├──> T2 (Storage) ──┬──> T3 (Router) ──┐
             │                   │                  ├──> V1 (Tests)
             │                   └──> T4 (Agent) ───┘
             │
             └──> (blocks all downstream)
```

## Implementation Notes

### Tier Ordering
Quality tiers follow this hierarchy: **S > A > B > C > D**

`tier_min="B"` should return content with tier in `["S", "A", "B"]` (anything B or better).

### Tags Filter Change
Current implementation uses `CONTAINSALL` (AND logic: content must have ALL tags).
**Decision**: Use `CONTAINSANY` (OR logic: content can match any provided tag).

### Tier Validation Contract
- Router/API layer is strict: accept only `S/A/B/C/D` for `tier_min`, normalize input case to uppercase.
- Internal services remain defensive: tolerate `None`/unexpected values without crashing.

### Tier NULL Behavior
When `tier_min` is provided, records with `tier = NULL` are excluded from results.

### SurrealDB Query Pattern
```surrealql
WHERE embedding != NONE
  AND vector::similarity::cosine(embedding, $embedding) > 0.3
  AND content_id.tier IN $valid_tiers  -- Added tier filter
  AND content_id.tags CONTAINSANY $tags  -- Tag OR matching
ORDER BY score DESC
LIMIT $limit
```

### Agent Service Flow
The agent service generates multiple queries, runs vector search for each, and fuses results with RRF. Filters must be applied to EACH vector search call, not just once.

## Success Metrics

1. Both search endpoints accept tier_min parameter
2. Tier filtering correctly excludes lower-tier content
3. Combined filters (tier + tags + content_type) work together
4. All unit and integration tests pass
5. No regressions in existing search functionality
6. Linter passes with no warnings

## Future Extensions

- Date range filters (created_at, updated_at)
- Metadata field filters (e.g., YouTube channel_id)
- Tier-based result boosting (increase score for higher tiers)
