# Team Plan: Merge Summary into Classification

## Objective
Absorb the old inline summary generation into the existing classification background task. A single LLM call now produces tier + score + labels + summary. Remove the dead `LLMService`/`get_llm_service()` code, clean up refetch scripts, and update all tests.

## Project Context
- **Language**: Python 3.12+ (FastAPI, Pydantic, pytest)
- **Test command**: `cd api && uv run pytest`
- **Lint command**: `cd api && uv run ruff check menos/ scripts/ tests/ && uv run ruff format --check menos/ scripts/ tests/`

## Team Members
| Name | Agent | Model | Role |
|------|-------|-------|------|
| msc-builder-core | builder | sonnet | Classification model/prompt/parser changes |
| msc-builder-router | builder | sonnet | Router cleanup + MinIO write wiring |
| msc-builder-cleanup | builder | haiku | Remove dead code from llm.py + scripts |
| msc-builder-tests | builder | sonnet | Update all test files |
| msc-validator | validator | haiku | Run tests, lint, stale ref checks |

## Tasks

### Task 1: Update ClassificationResult model and classification service
- **Owner**: msc-builder-core
- **Blocked By**: none
- **Description**:
  1. Add `summary: str = ""` field to `ClassificationResult` in `api/menos/models.py`
  2. Update `CLASSIFICATION_PROMPT_TEMPLATE` in `api/menos/services/classification.py`:
     - Add to RULES section: "Write a concise markdown summary: 2-3 sentence overview followed by 3-5 bullet points of main topics covered"
     - Add `"summary": "2-3 sentence overview.\n\n- Topic 1\n- Topic 2"` to the JSON example
  3. Bump `max_tokens` from 2000 to 3000 in `classify_content()` method
  4. In `_parse_classification_response()`: extract `summary = data.get("summary", "")`, validate it's a string, include in returned `ClassificationResult`
- **Acceptance Criteria**:
  - [ ] `ClassificationResult` has `summary: str = ""` field
  - [ ] Prompt template includes summary instruction in RULES
  - [ ] JSON example in prompt includes `"summary"` key
  - [ ] `max_tokens` is 3000
  - [ ] `_parse_classification_response` extracts and returns summary
  - [ ] No lint errors in modified files

### Task 2: Remove inline summary from youtube router + wire MinIO write
- **Owner**: msc-builder-router
- **Blocked By**: Task 1
- **Description**:
  1. In `api/menos/routers/youtube.py`:
     - Remove import of `LLMService, get_llm_service` (line 22)
     - Remove `llm_service: LLMService = Depends(get_llm_service)` param from `ingest_video()` (line 98)
     - Remove `"summary_model": getattr(llm_service, "model", "unknown")` from metadata_dict (line 173)
     - Delete the entire "Generate summary using LLM" block (lines 203-248)
     - Remove `summary: str | None = None` from `YouTubeIngestResponse` (line 62)
     - Remove `summary=summary` from response construction (line 312)
  2. In `_classify_background()` for `ingest_video()`: after `surreal_repo.update_content_classification(...)`, add MinIO summary write:
     ```python
     if result.summary:
         import io
         summary_data = io.BytesIO(result.summary.encode("utf-8"))
         await minio_storage.upload(
             f"youtube/{video_id}/summary.md", summary_data, "text/markdown"
         )
     ```
     Ensure `minio_storage` and `video_id` are captured in the closure.
  3. Same MinIO summary write pattern in `_classify_background()` for `upload_transcript()`. Capture `video_id = body.video_id` and `minio_storage` in the closure.
- **Acceptance Criteria**:
  - [ ] No `LLMService` or `get_llm_service` imports in youtube.py
  - [ ] `ingest_video()` has no `llm_service` parameter
  - [ ] No inline summary generation block remains
  - [ ] `YouTubeIngestResponse` has no `summary` field
  - [ ] Both `_classify_background()` closures write summary.md to MinIO when available
  - [ ] `io` is still imported (needed for MinIO upload in background task)
  - [ ] No `summary_model` in metadata_dict

### Task 3: Remove dead code from llm.py and refetch scripts
- **Owner**: msc-builder-cleanup
- **Blocked By**: Task 2
- **Description**:
  1. In `api/menos/services/llm.py`:
     - Delete lines 133-134: `LLMService = OllamaLLMProvider`
     - Delete lines 137-141: the `get_llm_service()` function
     - Keep `LLMProvider` protocol and `OllamaLLMProvider` class intact
     - Update module docstring from "LLM service for text generation using Ollama" to "LLM provider protocol and Ollama implementation"
  2. In `api/scripts/refetch_metadata.py`:
     - Remove `build_openrouter_chain` from import on line 9 (keep `get_storage_context`)
     - Remove `llm_service = build_openrouter_chain()` (line 20)
     - Delete summary generation block (lines 82-117)
  3. In `api/scripts/refetch_selected.py`:
     - Remove `build_openrouter_chain` from import on line 11 (keep `get_storage_context`)
     - Remove `llm_service = build_openrouter_chain()` (line 33)
     - Remove `"summary_model"` key from metadata dict (line 89)
     - Delete the Fabric-style prompt and summary generation block (lines 99-178)
- **Acceptance Criteria**:
  - [ ] `llm.py` has no `LLMService` alias or `get_llm_service()` function
  - [ ] `LLMProvider` protocol and `OllamaLLMProvider` class remain intact
  - [ ] `refetch_metadata.py` has no LLM imports or summary generation
  - [ ] `refetch_selected.py` has no LLM imports, summary_model, or summary generation
  - [ ] Both refetch scripts still work for metadata fetch + update

### Task 4: Update all tests
- **Owner**: msc-builder-tests
- **Blocked By**: Task 1, Task 2, Task 3
- **Description**:
  1. `api/tests/conftest.py`:
     - Remove `from menos.services.llm import get_llm_service` (line 24)
     - Remove `mock_llm_service` fixture (lines 134-140)
     - Remove `mock_llm_service` from `app_with_keys` fixture params (line 157)
     - Remove `app.dependency_overrides[get_llm_service] = lambda: mock_llm_service` (line 179)
  2. `api/tests/unit/test_llm.py`:
     - Remove `LLMService` from imports
     - Remove `test_llm_service_alias` test method
  3. `api/tests/unit/test_refetch_script.py`:
     - Remove `mock_llm_service` fixture
     - Remove `mock_llm_service` from `patched_refetch` fixture params
     - Remove `build_openrouter_chain` from the patch block
     - Update `test_processes_all_youtube_videos`: change expected upload count from 4 to 2
     - Delete `test_generates_summary_via_llm`, `test_uploads_summary_to_minio`, `test_handles_summary_generation_failure`
  4. `api/tests/integration/test_youtube.py`:
     - Remove `mock_llm_service` param from `test_ingest_video_stores_youtube_tags` and `test_ingest_video_stores_empty_tags_when_no_metadata`
  5. `api/tests/unit/test_classification.py`:
     - Add `"summary": "Test summary overview.\n\n- Topic 1\n- Topic 2"` to `mock_llm_provider` fixture JSON response
     - Add `test_summary_parsed` test in `TestHappyPath`
     - Add `test_missing_summary_defaults_to_empty` test in `TestLLMErrorHandling` (LLM returns JSON without summary key)
     - Update `TestClassificationResult.test_defaults` to assert `result.summary == ""`
- **Acceptance Criteria**:
  - [ ] No references to `mock_llm_service`, `get_llm_service`, or `LLMService` in test files
  - [ ] No summary-related tests in `test_refetch_script.py`
  - [ ] Upload count assertions updated in refetch tests
  - [ ] Classification tests cover summary parsing and default behavior
  - [ ] All tests pass: `cd api && uv run pytest -x`

### Task 5: Validate implementation
- **Owner**: msc-validator
- **Blocked By**: Task 4
- **Description**: Run linters, tests, and stale reference checks on all changes
- **Acceptance Criteria**:
  - [ ] `cd api && uv run pytest tests/unit/ -v` passes
  - [ ] `cd api && uv run pytest tests/integration/ -v` passes
  - [ ] `cd api && uv run ruff check menos/ scripts/ tests/` passes
  - [ ] `cd api && uv run ruff format --check menos/ scripts/ tests/` passes
  - [ ] No stale references: grep for `LLMService`, `get_llm_service`, `summary_model`, `summary_prompt` in production code returns nothing
  - [ ] No debug statements or hardcoded secrets

## Dependency Graph
```
Task 1 (core model/service) → Task 2 (router cleanup) → Task 3 (dead code removal) → Task 4 (tests) → Task 5 (validation)
```
