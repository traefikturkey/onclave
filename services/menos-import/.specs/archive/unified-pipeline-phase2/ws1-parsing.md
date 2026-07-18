---
created: 2026-02-11
completed: 2026-02-11
status: completed
parent: plan.md
---

# Team Plan: WS1 — Parsing + Orchestration

## Objective

Build the foundation for the unified pipeline: a single LLM call that produces combined
classification + entity extraction results, parsed through a shared JSON utility, with
all-or-nothing persistence semantics. This replaces the current dual-task architecture
where classification and entity extraction are separate LLM calls with separate parsers.

## Project Context

- **Language**: Python 3.12+
- **Framework**: FastAPI, Pydantic, SurrealDB
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Format command**: `cd api && uv run ruff format menos/`

## Current State (What Exists)

### Duplicated JSON extraction (to consolidate into llm_json.py)
- `api/menos/services/classification.py:107-138` — `_extract_json_from_response()`
- `api/menos/services/entity_extraction.py:136-170` — `_extract_json_from_response()`
- Both implementations are nearly identical: try direct parse, then regex for code blocks

### Current LLM response schemas (to unify)
- **Classification**: `{labels, new_labels, tier, tier_explanation, quality_score, score_explanation, summary}`
- **Entity extraction**: `{topics, pre_detected_validations, additional_entities}`
- Plan mandates `tags` terminology everywhere (replace `labels` in prompts/responses)

### Current result models (in api/menos/models.py)
- `ClassificationResult`: labels, tier, tier_explanation, quality_score, score_explanation, summary, model, classified_at
- `ExtractionResult`: topics, pre_detected_validations, additional_entities
- `ExtractionMetrics`: content_id, pre_detected_count, llm_extracted_count, etc.

### Test patterns (follow these exactly)
- Location: `api/tests/unit/`
- Fixtures: `MagicMock` for sync, `AsyncMock` for async
- Style: class-based test groups, `@pytest.mark.asyncio`
- See `api/tests/unit/test_classification.py` for canonical example

## Team Members

| Name | Agent | Role |
|------|-------|------|
| ws1-builder | builder (sonnet) | Implement all code changes TDD-style |
| ws1-validator | validator (haiku) | Run tests, lint, verify acceptance criteria |

## Tasks

### Task 1: TDD unified parser contract

- **Owner**: ws1-builder
- **Blocked By**: none
- **Description**: Create `api/tests/unit/test_unified_parser.py` defining the contract for parsing a unified LLM response that combines classification + entity extraction into one schema.

  The unified response schema should be:
  ```json
  {
    "tags": ["existing-tag-1", "existing-tag-2"],
    "new_tags": ["genuinely-new-tag"],
    "tier": "B",
    "tier_explanation": ["Reason 1", "Reason 2"],
    "quality_score": 55,
    "score_explanation": ["Reason 1", "Reason 2"],
    "summary": "2-3 sentence overview.\n\n- Bullet 1\n- Bullet 2",
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

  The parser function to test will live in `api/menos/services/unified_pipeline.py` and be named `parse_unified_response(data: dict, existing_tags: list[str], settings: Settings) -> UnifiedResult`.

  Create a `UnifiedResult` Pydantic model in `api/menos/models.py` that composes `ClassificationResult` fields + `ExtractionResult` fields into one model. Keep existing models untouched (they'll be removed in a later workstream).

- **Acceptance Criteria**:
  - [ ] `test_unified_parser.py` exists with class-based test groups
  - [ ] Tests cover: valid payload parsing, tag validation (lowercase hyphenated, `^[a-z][a-z0-9-]*$`), tier validation (S/A/B/C/D, invalid defaults to C), score clamping (1-100), new_tags dedup against existing, topic parsing with hierarchy, validation of pre_detected entries, additional entity parsing, malformed payload rejection (returns failure/None)
  - [ ] `UnifiedResult` model added to `models.py` with all required fields
  - [ ] Tests import from `menos.services.unified_pipeline` (will fail until Task 4)
  - [ ] Uses `tags` terminology throughout (never `labels`)

### Task 2: Shared LLM JSON utility

- **Owner**: ws1-builder
- **Blocked By**: Task 1
- **Description**: Create `api/menos/services/llm_json.py` by extracting the duplicated `_extract_json_from_response()` logic from both `classification.py` and `entity_extraction.py` into a shared utility.

  Steps:
  1. Create `api/menos/services/llm_json.py` with `extract_json(response: str) -> dict[str, Any]`
  2. Update `classification.py` to import from `llm_json` instead of using local `_extract_json_from_response`
  3. Update `entity_extraction.py` to import from `llm_json` instead of using local `_extract_json_from_response`
  4. Delete the local `_extract_json_from_response` from both files
  5. Update test imports if any tests reference the old private functions (e.g., `test_classification.py::TestJsonExtraction` imports `_extract_json_from_response` from classification — update to import from `llm_json`)

  The shared utility should match the existing behavior exactly. Do NOT add new features, retries, or validation beyond what already exists.

- **Acceptance Criteria**:
  - [ ] `api/menos/services/llm_json.py` exists with `extract_json()` function
  - [ ] No `_extract_json_from_response` remains in `classification.py` or `entity_extraction.py`
  - [ ] Both services import from `llm_json`
  - [ ] All existing tests in `test_classification.py` and `test_entity_extraction.py` still pass
  - [ ] `test_classification.py::TestJsonExtraction` updated to test `llm_json.extract_json`

### Task 3: TDD unified orchestration

- **Owner**: ws1-builder
- **Blocked By**: Task 1
- **Description**: Create `api/tests/unit/test_unified_pipeline.py` defining the contract for the unified pipeline orchestration service.

  The `UnifiedPipelineService` should:
  - Accept `content_id, content_text, content_type, title, pre_detected_entities, description_urls`
  - Make a SINGLE LLM call with a combined prompt
  - Parse the unified response using the parser from Task 1
  - Return `UnifiedResult` (or None on failure/skip)

  Test cases should cover:
  - Happy path: valid content produces UnifiedResult with both classification + entity fields
  - Skip conditions: disabled via settings
  - LLM failure: returns None
  - Invalid JSON response: returns None
  - Content truncation: text >10k chars is truncated with marker
  - Tag dedup: new_tags near-duplicate of existing are mapped to existing
  - Prompt includes existing tags, pre-detected entities, existing topics
  - Model name and timestamp are recorded on result
  - Uses `tags` terminology in prompt (not `labels`)

  Mock all external dependencies: LLM provider and repository.

- **Acceptance Criteria**:
  - [ ] `test_unified_pipeline.py` exists with class-based test groups
  - [ ] All test cases listed above are present
  - [ ] Tests import `UnifiedPipelineService` from `menos.services.unified_pipeline`
  - [ ] Tests use same mock patterns as `test_classification.py` (MagicMock/AsyncMock, fixtures)
  - [ ] Tests will fail until Task 4 implements the service

### Task 4: Implement unified pipeline service

- **Owner**: ws1-builder
- **Blocked By**: Task 2, Task 3
- **Description**: Create `api/menos/services/unified_pipeline.py` implementing:

  1. `parse_unified_response()` — the parser function tested in Task 1
  2. `UnifiedPipelineService` — the orchestration service tested in Task 3

  Implementation guidance:
  - Combine the classification prompt template and entity extraction prompt template into ONE unified prompt
  - The prompt should produce the unified JSON schema defined in Task 1
  - Use `extract_json()` from `llm_json.py` (Task 2) for response parsing
  - Reuse validation logic from existing services (tag regex, tier validation, score clamping, topic hierarchy parsing, confidence mapping, edge type mapping)
  - Import helpers from existing modules where possible (e.g., confidence/entity parsing helpers from entity_extraction)
  - Do NOT modify entity_resolution.py in this task (composition changes come in later workstream)
  - Service constructor takes: `llm_provider, repo, settings`
  - Main method: `async def process(content_id, content_text, content_type, title, pre_detected=None, existing_topics=None) -> UnifiedResult | None`

  After implementation, ALL tests from Tasks 1 and 3 must pass.

  Failure behavior contract:
  - Parser/orchestration failures must return `None` and be handled by caller as job failure.
  - No partial persistence is allowed from parse/validation failures.

- **Acceptance Criteria**:
  - [ ] `api/menos/services/unified_pipeline.py` exists
  - [ ] `parse_unified_response()` handles the full unified schema
  - [ ] `UnifiedPipelineService.process()` makes a single LLM call
  - [ ] Uses `tags` terminology in prompts and response parsing
  - [ ] Uses `extract_json()` from `llm_json.py`
  - [ ] Reuses existing validation helpers (not duplicated)
  - [ ] All tests in `test_unified_parser.py` pass
  - [ ] All tests in `test_unified_pipeline.py` pass
  - [ ] All existing tests still pass (no regressions)
  - [ ] `uv run ruff check menos/` passes with zero warnings

### Task 5: Validate implementation

- **Owner**: ws1-validator
- **Blocked By**: Task 1, Task 2, Task 3, Task 4
- **Description**: Run linters, all unit tests, and verify acceptance criteria from Tasks 1-4.
- **Verification Commands**:
  ```bash
  cd api && uv run ruff check menos/
  cd api && uv run ruff format --check menos/
  cd api && uv run pytest tests/unit/ -v
  ```
- **Acceptance Criteria**:
  - [ ] All linters pass with zero warnings
  - [ ] All unit tests pass (including new and existing)
  - [ ] No debug statements (`print()`, `breakpoint()`, `pdb`)
  - [ ] No hardcoded secrets or API keys
  - [ ] `UnifiedResult` model exists in `models.py`
  - [ ] `llm_json.py` exists and is used by both classification and entity_extraction
  - [ ] `unified_pipeline.py` exists with parser and service
  - [ ] `test_unified_parser.py` and `test_unified_pipeline.py` exist and pass
  - [ ] No duplicate `_extract_json_from_response` in classification.py or entity_extraction.py
  - [ ] `tags` terminology used (not `labels`) in new code

## Dependency Graph

```
Task 1 (parser tests) ──┬──> Task 2 (llm_json.py)
                         │
                         └──> Task 3 (orchestration tests)
                                      │
Task 2 + Task 3 ─────────────> Task 4 (unified_pipeline.py)
                                      │
Tasks 1-4 ────────────────────> Task 5 (validation)
```

## Files to Create
- `api/menos/services/llm_json.py`
- `api/menos/services/unified_pipeline.py`
- `api/tests/unit/test_unified_parser.py`
- `api/tests/unit/test_unified_pipeline.py`

## Files to Modify
- `api/menos/models.py` — add `UnifiedResult` model
- `api/menos/services/classification.py` — replace local JSON extraction with `llm_json` import
- `api/menos/services/entity_extraction.py` — replace local JSON extraction with `llm_json` import
- `api/tests/unit/test_classification.py` — update JSON extraction test imports

## Files NOT to Touch (Later Workstreams)
- `api/menos/services/entity_resolution.py`
- `api/menos/services/di.py`
- `api/menos/routers/*`
- `api/menos/config.py`
- Any migration files
