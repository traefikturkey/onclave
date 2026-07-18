---
created: 2026-02-15
completed: 2026-02-15
---

# Team Plan: Video Annotations

## Objective

Add an `annotation` content type to menos that stores structured text extracted from video screenshots (slides, diagrams, code) and links it to the parent video. Annotations should be queryable by parent content, show up in content listings, and be searchable alongside transcripts.

**User story**: "I have screenshots from a YouTube video showing slides with architecture diagrams and text. I want to extract that text and store it linked to the video so I can search/retrieve it later."

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic, SurrealDB)
- **Working directory**: `C:\Users\Mike\.dotfiles\menos\api`
- **Test command**: `uv run pytest tests/unit/ -v`
- **Lint command**: `uv run ruff check menos/`
- **Key patterns**: ContentMetadata with flexible `metadata` dict, DI via FastAPI Depends, RFC 9421 auth, RecordID gotcha for WHERE clauses

## Design Decisions

1. **Reuse `content` table** with `content_type="annotation"` — no new SurrealDB table needed
2. **Parent reference via `metadata.parent_content_id`** — explicit, queryable, no link system dependency
3. **SurrealDB index** on `metadata.parent_content_id` WHERE `content_type='annotation'` for fast lookup
4. **Store annotation text in MinIO** at `annotations/{parent_id}/{annotation_id}.md` — follows existing pattern where MinIO holds file content and SurrealDB holds metadata
5. **Skip pipeline processing** — annotations are user-curated, not auto-processed. No chunking/embedding for now.
6. **Nested under content router** — `POST /api/v1/content/{id}/annotations` and `GET /api/v1/content/{id}/annotations` as sub-resources of the parent

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Storage layer + migration | 2 | mechanical | haiku | builder-light |
| T2: Annotations router + tests | 4 | feature | sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| annotations-builder-1 | builder-light | haiku | Storage layer + migration |
| annotations-builder-2 | builder | sonnet | Router endpoints + tests |
| annotations-validator-1 | validator | haiku | Wave 1 validation |
| annotations-validator-2 | validator-heavy | sonnet | Wave 2 validation |

## Execution Waves

### Wave 1
- T1: Add `find_content_by_parent_id()` to storage.py + migration [haiku] — builder-light

### Wave 1 Validation
- V1: Validate storage method + migration [haiku] — validator, blockedBy: [T1]

### Wave 2
- T2: Create annotations router + register in main.py + unit tests [sonnet] — builder, blockedBy: [V1]

### Wave 2 Validation
- V2: Validate router + tests + lint [sonnet] — validator-heavy, blockedBy: [T2]

## Dependency Graph
Wave 1: T1 → V1 → Wave 2: T2 → V2

## Task Details

### T1: Storage Layer + Migration

**Files:**
- `api/menos/services/storage.py` — Add method to `SurrealDBRepository`
- `api/migrations/YYYYMMDD-HHMMSS_annotation_parent_index.surql` — New migration

**Implementation:**

1. Add to `SurrealDBRepository`:
```python
async def find_content_by_parent_id(
    self, parent_content_id: str, content_type: str | None = None
) -> list[ContentMetadata]:
    """Find content records linked to a parent content ID via metadata."""
    query = (
        "SELECT * FROM content "
        "WHERE metadata.parent_content_id = $parent_id"
    )
    params: dict = {"parent_id": parent_content_id}
    if content_type:
        query += " AND content_type = $content_type"
        params["content_type"] = content_type
    query += " ORDER BY created_at DESC"
    result = self.db.query(query, params)
    rows = result[0]["result"] if result and result[0].get("result") else []
    return [_parse_content(row) for row in rows]
```

2. Migration file (use timestamp format matching existing migrations):
```sql
-- Add index for annotation parent lookups
DEFINE INDEX IF NOT EXISTS idx_content_parent_id
    ON content
    FIELDS metadata.parent_content_id
    WHERE content_type = 'annotation';
```

**Acceptance Criteria:**
1. [ ] Method `find_content_by_parent_id` exists in `SurrealDBRepository` class
   - Verification: `grep -n "find_content_by_parent_id" api/menos/services/storage.py`
   - Expected: Method definition found
2. [ ] Method accepts `parent_content_id: str` and optional `content_type: str | None`
   - Verification: Read method signature in storage.py
   - Expected: Both parameters present with correct types
3. [ ] Method returns `list[ContentMetadata]` using `_parse_content()` helper
   - Verification: Read method body, confirm it uses `_parse_content`
   - Expected: Result rows parsed through `_parse_content`
4. [ ] Migration file exists with correct index definition
   - Verification: `ls api/migrations/*annotation*`
   - Expected: One migration file found with DEFINE INDEX statement
5. [ ] Lint passes: `uv run ruff check menos/services/storage.py`
   - Expected: No errors

### T2: Annotations Router + Tests

**Files:**
- `api/menos/routers/annotations.py` — New router file
- `api/menos/main.py` — Register new router
- `api/tests/unit/test_annotations_router.py` — New test file

**Implementation:**

1. Create `api/menos/routers/annotations.py`:

Models:
```python
class AnnotationCreate(BaseModel):
    text: str  # The extracted/annotated text content
    title: str | None = None  # Optional title (e.g., slide title)
    source_type: str = "screenshot"  # screenshot, manual, ocr
    tags: list[str] = []

class AnnotationResponse(BaseModel):
    id: str
    parent_content_id: str
    text: str
    title: str | None
    source_type: str
    tags: list[str]
    created_at: datetime | None
```

Endpoints:
- `POST /api/v1/content/{content_id}/annotations` — Create annotation
  - Validate parent exists via `surreal_repo.get_content(content_id)`
  - Store text in MinIO at `annotations/{content_id}/{annotation_id}.md`
  - Create `ContentMetadata(content_type="annotation", metadata={"parent_content_id": content_id, "source_type": source_type}, ...)`
  - Return `AnnotationResponse`

- `GET /api/v1/content/{content_id}/annotations` — List annotations for parent
  - Call `surreal_repo.find_content_by_parent_id(content_id, content_type="annotation")`
  - Return `list[AnnotationResponse]`

2. Register in `main.py`:
```python
from menos.routers.annotations import router as annotations_router
app.include_router(annotations_router, prefix="/api/v1")
```

3. Write unit tests covering:
- Create annotation returns 200 with correct fields
- Create annotation for non-existent parent returns 404
- List annotations returns empty list when none exist
- List annotations returns created annotations
- Create annotation stores file in MinIO
- Create annotation creates ContentMetadata in SurrealDB with correct metadata dict

**Acceptance Criteria:**
1. [ ] `POST /api/v1/content/{id}/annotations` creates an annotation record
   - Verification: `uv run pytest tests/unit/test_annotations_router.py -v -k "test_create"`
   - Expected: All create tests pass
2. [ ] `GET /api/v1/content/{id}/annotations` returns annotations for parent
   - Verification: `uv run pytest tests/unit/test_annotations_router.py -v -k "test_list"`
   - Expected: All list tests pass
3. [ ] Parent validation returns 404 for non-existent parent
   - Verification: `uv run pytest tests/unit/test_annotations_router.py -v -k "not_found"`
   - Expected: Test passes asserting 404
4. [ ] Router registered in main.py
   - Verification: `grep "annotations" api/menos/main.py`
   - Expected: Import and include_router found
5. [ ] All tests pass: `uv run pytest tests/unit/test_annotations_router.py -v`
   - Expected: All tests pass, 0 failures
6. [ ] Lint passes: `uv run ruff check menos/routers/annotations.py`
   - Expected: No errors
7. [ ] Full unit suite still passes: `uv run pytest tests/unit/ -x --timeout=60`
   - Expected: No regressions
