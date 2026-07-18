---
created: 2026-02-11
completed:
started: 2026-02-12
---

# Team Plan: Content Cross-Referencing via Shared Entities

## Objective

Enable on-demand discovery of related content through shared entities, exposed via API. Given a `content_id`, return related content that shares the most entities, with full detail by default and deterministic ranking.

## Project Context

- **Language**: Python 3.12+ (FastAPI, Pydantic)
- **Database**: SurrealDB (supports graph traversal)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Existing systems**:
  - `entity` table: stores 5 entity types (TOPIC, REPO, PAPER, TOOL, PERSON)
  - `content_entity` edge table: connects content to entities
  - `api/menos/routers/graph.py`: knowledge graph visualization endpoints
  - `api/menos/services/storage.py`: SurrealDBRepository pattern

## Complexity Analysis

**Scope**: Small-to-medium, focused feature
- **Lines of code**: ~220 (query + model + storage + router + tests)
- **Files touched**: 5 (models.py, storage.py, graph.py, test_storage.py, router tests)
- **Complexity**: Low-to-moderate - single SurrealDB graph query plus API exposure
- **Risk**: Low - read-only query, no schema changes, additive API endpoint

**Unknowns**:
- Exact SurrealDB graph traversal syntax (needs experimentation)
- Performance with large entity graphs (deferred - optimize if pain emerges)

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| crossref-builder-1 | builder | sonnet | Query, model, storage, tests |
| crossref-validator-1 | validator | haiku | Wave validation |

## Execution Waves

### Wave 1: Core Implementation
**Builder_1** implements:

1. **Pydantic model** (`api/menos/models.py`):
   ```python
   class RelatedContent(BaseModel):
       content_id: str
       title: str
       content_type: str
       shared_entity_count: int
       shared_entities: list[str]
   ```

2. **Storage method** (`api/menos/services/storage.py`):
   ```python
   async def get_related_content(
       self,
       content_id: str,
        limit: int = 10,
        window: str = "12m",
   ) -> list[RelatedContent]:
       """Find content related through shared entities.

        Args:
            content_id: Source content to find relations for
            limit: Maximum number of related items to return (1-50)
            window: Recency filter (`0` for all, otherwise `^\d+[mwd]$`; default `12m`)

       Returns:
            List of related content with full detail, sorted by ranking rules
        """
   ```

3. **SurrealDB graph query and ranking rules**:
   - Start from `content_entity` WHERE `content_id = $content_id`
   - Traverse to entities
   - Traverse back to other content via `content_entity`
   - Include all entity types equally (no type weighting)
   - Group by content, count shared entities, collect entity names
   - Apply minimum threshold: `shared_entity_count >= 2`
   - Exclude self (`WHERE other_content.id != $content_id`)
   - Apply recency filter on candidate `other_content.created_at`:
     - default `window=12m`
     - `window=0` disables recency filtering (all content)
     - months are calendar-aware for month-based values
   - Sort by `shared_entity_count DESC`, tie-break `created_at DESC`, then `content_id ASC`
   - Limit results

   Example query structure (syntax needs verification):
   ```surql
   SELECT
       other_content.id AS content_id,
       other_content.title AS title,
       other_content.content_type AS content_type,
       count() AS shared_entity_count,
       array::group(entity.name) AS shared_entities
   FROM content_entity
   WHERE content_id = $content_id
   -- Traverse through entity to other content_entity edges
   -- Group and aggregate
    HAVING shared_entity_count >= 2
    ORDER BY shared_entity_count DESC, created_at DESC, content_id ASC
    LIMIT $limit
   ```

4. **API endpoint** (`api/menos/routers/graph.py`):
    - Add `GET /api/v1/content/{content_id}/related`
    - Require standard API authentication
    - Query params:
      - `limit` default `10`, min `1`, max `50`
      - `window` accepts `0` or duration string matching `^\d+[mwd]$` (default `12m`)
   - Response behavior:
     - Source `content_id` not found -> `404`
     - Source found but no related items -> `200` with empty list
   - Response payload includes full detail by default, including `shared_entities`

5. **Tests** (`api/tests/unit/test_storage.py` + router tests):
   - Mock SurrealDB response with sample related content
   - Verify correct query parameters passed
   - Verify RecordID conversion for content_id param
   - Verify minimum shared-entity threshold applied (`>= 2`)
    - Verify ranking order: shared count DESC, created_at DESC, content_id ASC
    - Verify all entity types are treated equally in scoring
    - Verify recency filter uses `created_at` and supports default `12m`
    - Verify window validation accepts `0` and duration strings matching `^\d+[mwd]$`
    - Verify no explicit upper bounds are enforced for window duration values
   - Verify empty result handling
   - Verify limit parameter validation and bounds (1..50)
   - Verify source-not-found yields 404 at API layer
   - Verify source-found/no-related yields 200 with empty list
   - Verify API response includes `shared_entities` by default

**Acceptance Criteria**:
- [ ] `RelatedContent` model added to `models.py`
- [ ] `get_related_content()` method added to `SurrealDBRepository`
- [ ] `GET /api/v1/content/{content_id}/related` endpoint added
- [ ] Endpoint requires standard API auth
- [ ] SurrealDB query returns related content with shared entity counts and `shared_entities`
- [ ] Results exclude self (source content_id)
- [ ] Minimum shared-entity threshold enforced (`shared_entity_count >= 2`)
- [ ] Results sorted by `shared_entity_count DESC`, `created_at DESC`, `content_id ASC`
- [ ] Limit parameter validated and respected (default 10, min 1, max 50)
- [ ] Window parameter validation: accepts `0` or duration string matching `^\d+[mwd]$` (default `12m`)
- [ ] Recency filter uses `created_at` with calendar-aware month semantics
- [ ] Source content not found returns 404
- [ ] Source found with no related content returns 200 with empty list
- [ ] Unit tests pass: `uv run pytest tests/unit/test_storage.py::test_get_related_content -v`
- [ ] API tests pass: `uv run pytest tests/unit/test_graph_router.py -v`
- [ ] Lint passes: `uv run ruff check menos/`
- [ ] RecordID objects handled correctly (see gotchas.md)

### Wave 1 Validation
- **V1: Validate wave 1** [haiku] — crossref-validator-1, blockedBy: [T1]
  - Run `cd api && uv run pytest tests/unit/ -v` — all tests pass
  - Run `cd api && uv run ruff check menos/` — no lint errors
  - Verify `RelatedContent` model exists in models.py
  - Verify `get_related_content()` method exists in storage.py

## Dependency Graph

```
Wave 1: T1 (crossref-builder-1) → V1 (crossref-validator-1)
```

## Deferred Decisions

**Not in scope** (to be addressed in future specs):
- Caching strategy (if query performance becomes pain point)
- Pre-computation at ingestion time (if real-time query too slow)
- Filtering by entity type or confidence threshold
- Alternative API surfaces beyond REST

**Rationale**: Implement the agreed REST endpoint now, then iterate on optimization and alternative surfaces after validating usage and performance.

## Notes

- **On-demand only**: No pre-computation, query runs at request time
- **Graph query experimentation**: Builder may need to iterate on SurrealDB syntax
- **RecordID gotcha**: Remember to use `RecordID("content", content_id)` for WHERE clause parameters (see `.claude/rules/gotchas.md`)
- **Test isolation**: Mock SurrealDB responses, no live database required for unit tests
