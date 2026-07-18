# Team Plan: Content Classification Service

## Context

menos has entity extraction (hierarchical topics) and tags (flat, user-facing), but no quality assessment of content. The user wants to classify ingested content with quality ratings (S/A/B/C/D tiers + 1-100 scores) and labels, biased toward their interests. An existing one-off `classify_transcript.py` script validates the concept but is not integrated into the API.

Four expert reviews (architecture, adversarial, ML/personalization, topic extraction) identified key improvements incorporated below.

## Objective

Add a content classification service that:
- Assigns quality tiers (S/A/B/C/D) and scores (1-100) biased toward user interests
- Assigns labels from existing vault labels, with deterministic dedup for new ones
- Runs as fire-and-forget async during ingestion (no latency impact)
- Provides a manual endpoint and batch script for reclassification
- Stores structured JSON results including model name

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic, httpx)
- **Test command**: `make test` → `cd api && uv run pytest -v`
- **Lint command**: `make lint` → `cd api && uv run ruff check .`

## Key Design Decisions

### Labels + Quality Rating (not quality-only)
Classification produces both labels AND quality ratings. Labels serve a different purpose from entity topics: quick single-word scanning/filtering vs. deep hierarchical categorization. Entity topics remain unchanged.

### Fire-and-Forget Async During Ingestion
Classification runs as `asyncio.create_task()` after ingestion completes. The ingestion endpoint returns immediately. Classification results appear asynchronously via status field. Prevents the 30-120s+ latency penalty identified by the adversarial review.

### Deterministic Dedup First, LLM Fallback
New labels are first checked against existing labels using `normalize_name()` + Levenshtein distance from the existing `normalization.py`. Only if no close match (edit distance > 2), fall back to an LLM normalization call. This addresses the adversarial reviewer's concern about non-deterministic LLM normalization.

### No Seed Taxonomy — Grow Organically
Let the label space grow from content ingestion rather than pre-populating.

### Targeted UPDATE Queries (not full replace)
Per adversarial review C2: use `UPDATE content SET metadata.classification = $data` queries to avoid race conditions with concurrent ingestion. Never use `update_content()` for classification storage.

### Content Delimiters for Prompt Injection Defense
Wrap user content in `<CONTENT>` tags in the prompt, following the entity extraction pattern. Validate output schema strictly (tier must be S/A/B/C/D, score must be 1-100, labels must match `^[a-z][a-z0-9-]*$`).

### Multi-Signal Interest Profile
Interest profile derives from:
1. Entity topic `discusses` edges (highest weight)
2. Tag frequency with recency weighting
3. Channel affinity for YouTube (repeat ingestion = strong signal)

Computed via time-windowed SurrealQL queries, not stored state.

## Key Existing Patterns

| Pattern | File | Reuse |
|---------|------|-------|
| Entity extraction service | `api/menos/services/entity_extraction.py` | Prompt template, `_extract_json_from_response()`, `<CONTENT>` delimiters |
| Entity resolution pipeline | `api/menos/services/entity_resolution.py` | Status tracking, `refresh_matcher_cache()` caching pattern |
| Normalization utils | `api/menos/services/normalization.py` | `normalize_name()`, Levenshtein matching for dedup |
| DI factories | `api/menos/services/di.py` | `build_openrouter_chain()`, `@lru_cache` providers |
| Tags with counts | `api/menos/services/storage.py:311` | `list_tags_with_counts()` for existing labels |
| Content metadata model | `api/menos/models.py:50` | `metadata: dict` for classification storage |

## JSON Output Schema (from LLM)

```json
{
  "labels": ["programming", "kubernetes"],
  "new_labels": ["homelab"],
  "tier": "A",
  "tier_explanation": ["Rich technical content", "Directly relevant to interests"],
  "quality_score": 78,
  "score_explanation": ["Novel approach to deployment", "High information density"]
}
```

## Stored Classification Result (in content.metadata.classification)

```json
{
  "labels": ["programming", "kubernetes", "homelab"],
  "tier": "A",
  "tier_explanation": ["...", "..."],
  "quality_score": 78,
  "score_explanation": ["...", "..."],
  "model": "openrouter/quasar-alpha",
  "classified_at": "2026-02-10T12:00:00Z"
}
```

Also stored as top-level indexed fields for queryability:
- `classification_tier: option<string>` — enables `WHERE classification_tier = 'S'`
- `classification_score: option<int>` — enables `ORDER BY classification_score DESC`

## Team Members
| Name | Agent | Role |
|------|-------|------|
| classify-builder | builder (sonnet) | Implement all changes |
| classify-validator | validator (haiku) | Verify lint, tests, code quality |

## Tasks

### Task 1: Migration + Config + Model
- **Owner**: classify-builder
- **Blocked By**: none
- **Description**: Foundation work.

  **1a. Migration** — Create `api/migrations/20260210-120000_add_classification_fields.surql`:
  ```sql
  -- Classification status tracking and queryable fields
  DEFINE FIELD IF NOT EXISTS classification_status ON content TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS classification_at ON content TYPE option<datetime>;
  DEFINE FIELD IF NOT EXISTS classification_tier ON content TYPE option<string>;
  DEFINE FIELD IF NOT EXISTS classification_score ON content TYPE option<int>;
  -- Index for tier-based filtering
  DEFINE INDEX IF NOT EXISTS idx_content_classification_tier ON content FIELDS classification_tier;
  ```

  **1b. Config** — Add to `api/menos/config.py` after entity extraction settings:
  ```python
  # Content Classification
  classification_enabled: bool = True
  classification_provider: LLMProviderType = "openrouter"
  classification_model: str = ""
  classification_max_new_labels: int = 3
  classification_interest_top_n: int = 15
  classification_min_content_length: int = 500
  ```

  **1c. Model** — Add `ClassificationResult` to `api/menos/models.py`:
  ```python
  class ClassificationResult(BaseModel):
      labels: list[str] = Field(default_factory=list)
      tier: str = ""  # S, A, B, C, D
      tier_explanation: list[str] = Field(default_factory=list)
      quality_score: int = 0  # 1-100
      score_explanation: list[str] = Field(default_factory=list)
      model: str = ""
      classified_at: str = ""
  ```

- **Acceptance Criteria**:
  - [ ] Migration file uses `IF NOT EXISTS`, is idempotent
  - [ ] Top-level `classification_tier` and `classification_score` are indexed for queryability
  - [ ] Config settings load from env vars
  - [ ] `ClassificationResult` serializes cleanly to/from dict
  - [ ] `classification_min_content_length` defaults to 500 (consistent with entity extraction)

### Task 2: Storage layer methods
- **Owner**: classify-builder
- **Blocked By**: Task 1
- **Description**: Add methods to `SurrealDBRepository` in `api/menos/services/storage.py`:

  **2a. `update_content_classification_status(content_id, status)`** — Targeted UPDATE for status field only.

  **2b. `update_content_classification(content_id, classification_dict)`** — Targeted UPDATE that:
  - Sets `metadata.classification = $data` (merges, does NOT full-replace)
  - Sets `classification_status = 'completed'`
  - Sets `classification_tier` and `classification_score` as top-level indexed fields
  - Sets `classification_at = time::now()`

  **2c. `get_interest_profile(top_n, recent_days=90)`** — New query for multi-signal interest profile:
  - Top entity topics by `discusses` edge count
  - Top tags with recency weighting
  - Top YouTube channels by video count
  - Returns structured dict for prompt formatting

- **Acceptance Criteria**:
  - [ ] Uses targeted `UPDATE SET` queries (never `update_content()` full replace)
  - [ ] Classification data merges into metadata without clobbering other keys
  - [ ] Interest profile query is a single efficient SurrealQL query (or batched)
  - [ ] Methods follow existing patterns (see `update_content_extraction_status`)

### Task 3: ClassificationService (core)
- **Owner**: classify-builder
- **Blocked By**: Task 1
- **Description**: Create `api/menos/services/classification.py`:

  **3a. `InterestProvider` protocol** — `async def get_interests() -> dict[str, list[str]]` returning `{"topics": [...], "tags": [...], "channels": [...]}`.

  **3b. `VaultInterestProvider`** — Calls `get_interest_profile()` from storage, returns structured interest data. Caches for 5 minutes (TTL) to avoid repeated full-table scans during batch runs.

  **3c. Classification prompt** — System prompt with:
  - Existing labels as comma-separated list (prefer these)
  - Interest profile as structured context (topics, tags, channels)
  - `max_new_labels` constraint
  - `<CONTENT>` delimiters around user content for prompt injection defense
  - JSON-only output instruction (no markdown)
  - Calibration: instruct LLM that 50 = average, 80+ = exceptional, <30 = low value

  **3d. `ClassificationService` class** with:
  - `classify_content(content_id, content_text, content_type, title) -> ClassificationResult | None`
  - Skip if disabled, content too short (<500 chars per config)
  - Truncate content to 10k chars
  - Call LLM with `temperature=0.3, max_tokens=2000, timeout=60.0` (tighter timeout per adversarial review)
  - Parse JSON using `_extract_json_from_response()` pattern
  - Validate output: tier in S/A/B/C/D, score clamped 1-100, labels match `^[a-z][a-z0-9-]*$`
  - **Deterministic label dedup**: For any new labels, run `normalize_name()` + Levenshtein check against existing labels. If edit distance ≤ 2, map to existing. Only use LLM fallback if no close match found AND `new_labels` count exceeds 0.
  - Record model name: use `getattr(provider, 'model', 'fallback_chain')` + timestamp

- **Acceptance Criteria**:
  - [ ] `InterestProvider` protocol is runtime-checkable
  - [ ] `VaultInterestProvider` caches results with TTL
  - [ ] Content wrapped in `<CONTENT>` tags in prompt
  - [ ] Deterministic dedup runs BEFORE any LLM fallback
  - [ ] Output validated strictly (tier, score, label format)
  - [ ] LLM errors caught gracefully (returns None)
  - [ ] Timeout set to 60s (not 120s)

### Task 4: DI factory + Router integration
- **Owner**: classify-builder
- **Blocked By**: Task 2, Task 3
- **Description**:

  **4a. DI factories** — In `api/menos/services/di.py`:
  - `get_classification_provider() -> LLMProvider` (with `@lru_cache`)
  - `get_classification_service() -> ClassificationService` (composes provider + VaultInterestProvider + repo + settings)

  **4b. YouTube ingestion** — In `api/menos/routers/youtube.py`:
  - After ingestion completes (after summary generation), launch classification as `asyncio.create_task()`
  - Set `classification_status = "pending"` on the content record before returning
  - The background task calls `classify_content()` then `update_content_classification()`
  - On failure, sets `classification_status = "failed"` and logs warning
  - Add `classification_status: str | None = None` to `YouTubeIngestResponse`
  - Apply to both `ingest_video()` and `upload_transcript()`

  **4c. Content upload** — In `api/menos/routers/content.py`:
  - Same async pattern after content creation + link extraction
  - Only for content with text > 500 chars

  **4d. Manual endpoint** — Create `api/menos/routers/classification.py`:
  - `POST /api/v1/content/{content_id}/classify` — Fetches content from MinIO, runs classification synchronously, stores result
  - Requires auth (`AuthenticatedKeyId`)
  - `force: bool = False` query param to allow reclassification
  - Response: `{ content_id, tier, quality_score, labels, model, status }`
  - Include router in `api/menos/main.py`

- **Acceptance Criteria**:
  - [ ] Classification runs as `asyncio.create_task()` (fire-and-forget)
  - [ ] Ingestion endpoints return immediately with `classification_status: "pending"`
  - [ ] Background task properly sets status to completed/failed
  - [ ] Manual endpoint is synchronous and returns full result
  - [ ] Manual endpoint path is RESTful: `/content/{id}/classify`
  - [ ] Errors in background task never affect the ingestion response

### Task 5: Batch reclassification script
- **Owner**: classify-builder
- **Blocked By**: Task 4
- **Description**: Create `api/scripts/classify_content.py` following `reprocess_content.py` pattern:
  - Process content in batches with offset/limit pagination
  - Set `classification_status = "processing"` BEFORE LLM call (enables resume on interrupt)
  - CLI flags: `--dry-run`, `--force`, `--content-type`, `--limit`
  - Cache interest profile once at start (not per-item)
  - Reports stats at end (total, classified, skipped, failed)
  - No hardcoded credentials or URLs (use `settings`)

- **Acceptance Criteria**:
  - [ ] Batched pagination following `reprocess_content.py` pattern
  - [ ] Status set to "processing" before LLM call for resumability
  - [ ] Interest profile cached once per run
  - [ ] Skips already-classified unless `--force`
  - [ ] No hardcoded credentials

### Task 6: Unit tests
- **Owner**: classify-builder
- **Blocked By**: Task 3
- **Description**: Create `api/tests/unit/test_classification.py`. Test cases:
  1. Classification disabled → returns None
  2. Short content (<500 chars) → returns None
  3. Parses labels from LLM JSON correctly
  4. Validates tier (S/A/B/C/D), rejects invalid → defaults to "C"
  5. Clamps quality score to 1-100
  6. Handles LLM error gracefully (returns None)
  7. Handles invalid JSON gracefully (returns None)
  8. Deterministic dedup maps "k8s" to existing "kubernetes" (edit distance)
  9. Deterministic dedup keeps genuinely new label when no close match
  10. VaultInterestProvider caches results within TTL
  11. Model name populated in result
  12. Content wrapped in `<CONTENT>` tags in generated prompt
  13. Labels validated against `^[a-z][a-z0-9-]*$` pattern

  Also update `api/tests/conftest.py`: add mock classification service + dependency override for `get_classification_service`.

- **Acceptance Criteria**:
  - [ ] At least 12 test cases
  - [ ] Covers happy path, error paths, dedup logic, validation
  - [ ] Uses MagicMock/AsyncMock for all dependencies
  - [ ] `make test` passes with zero failures
  - [ ] `make lint` passes with zero errors on new files

### Task 7: Validate implementation
- **Owner**: classify-validator
- **Blocked By**: Task 5, Task 6
- **Description**: Run linters, tests, and content checks
- **Verification Commands**: `cd api && uv run ruff check .` and `cd api && uv run pytest -v`
- **Acceptance Criteria**:
  - [ ] All linters pass (zero new warnings from modified files)
  - [ ] All tests pass (zero failures)
  - [ ] No hardcoded API keys or secrets
  - [ ] No debug print statements
  - [ ] Prompt does not contain forbidden text ("AI-generated", "Claude", etc.)
  - [ ] New files follow code style (100-char lines, type hints, async methods)
  - [ ] `asyncio.create_task()` used for fire-and-forget (not inline await)
  - [ ] Targeted UPDATE queries used (not `update_content()`)

## Dependency Graph
```
Task 1 (migration+config+model) ──┬── Task 2 (storage) ──┐
                                   │                       │
                                   └── Task 3 (service) ──┬── Task 4 (DI+routers) ── Task 5 (script) ──┐
                                                           │                                             │
                                                           └── Task 6 (tests) ─────────────────────────┼── Task 7 (validate)
```
