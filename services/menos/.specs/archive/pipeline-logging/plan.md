# Team Plan: Pipeline Logging

## Objective
Application-level logging from the menos API is invisible in `docker logs`. Python loggers
are never configured, so all `logger.info()`, `logger.warning()`, and `logger.error()` calls
across the classification service, ingest background tasks, and other services produce no
output. Additionally, fire-and-forget background tasks have error handling gaps that hide
failures and can leave zombie "pending" records.

We need to:
1. **Configure namespace logging** so app logs appear in container stdout
2. **Fix background task error handling** across all three `_classify_background()` closures
3. **Add task lifecycle management** to prevent orphaned tasks during shutdown

## Project Context
- **Language**: Python 3.12+, FastAPI, uvicorn
- **Test command**: `cd api && uv run pytest` (smoke tests excluded by default)
- **Lint command**: `cd api && uv run ruff check menos/ scripts/`
- **Key files**:
  - `api/menos/main.py` — FastAPI app, lifespan, no logging config
  - `api/menos/config.py` — Pydantic Settings, no LOG_LEVEL setting
  - `api/menos/routers/youtube.py` — two `_classify_background()` closures (ingest + upload)
  - `api/menos/routers/content.py` — third `_classify_background()` closure (upload_content)
  - `api/menos/services/classification.py` — ClassificationService with good internal logging
  - `api/Dockerfile` — `CMD ["uvicorn", "menos.main:app", "--host", "0.0.0.0", "--port", "8000"]`

## Expert Review Findings (Incorporated)

Four expert reviews (logging, debugging, microservices, async/FastAPI) identified these issues
with the original plan:

1. **`logging.basicConfig()` is a no-op under uvicorn** — uvicorn calls `dictConfig()` before
   importing the app module, adding handlers to root. `basicConfig()` silently does nothing
   when root already has handlers. Must use namespace logger or `force=True`.
2. **`content.py` has a third identical closure** — same bare `except: pass` bug, not in
   original plan scope.
3. **`asyncio.create_task()` discards task references** — Python docs warn tasks can be GC'd.
   No shutdown coordination means zombie "pending" records on SIGTERM.
4. **`CancelledError` is `BaseException`** — `except Exception` doesn't catch it. During
   shutdown, cancelled tasks skip the "failed" status update.
5. **Dockerfile `--log-level info` is redundant** — uvicorn defaults to info already.
6. **Zero `exc_info=True` in entire codebase** — no tracebacks in any error log.

## Team Members
| Name | Agent | Role |
|------|-------|------|
| pipeline-logging-builder | builder (sonnet) | Implement all changes |
| pipeline-logging-validator | validator (haiku) | Verify lint, tests, and code quality |

## Tasks

### Task 1: Configure namespace logging, fix background tasks, add shutdown drain
- **Owner**: pipeline-logging-builder
- **Blocked By**: none
- **Description**:

  ### Fix 1: Configure `menos` namespace logger in `main.py`

  **Do NOT use `logging.basicConfig()`** — it will be a no-op because uvicorn configures
  root logger handlers before importing the app module.

  Instead, configure the `menos` namespace logger directly. This ensures all `menos.*` child
  loggers (routers, services) get a handler while leaving uvicorn's own loggers untouched.

  Add this at module level in `main.py`, after imports but before app creation:

  ```python
  import os

  LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()

  _log_handler = logging.StreamHandler()
  _log_handler.setFormatter(
      logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
  )
  logging.getLogger("menos").setLevel(LOG_LEVEL)
  logging.getLogger("menos").addHandler(_log_handler)
  ```

  Why `os.environ.get()` instead of `settings.log_level`: logging must be configured before
  Pydantic Settings initialization, and `config.py` may be imported by other modules first.

  **Do NOT modify the Dockerfile CMD.** Uvicorn defaults to `--log-level info` already.
  Adding it explicitly creates a maintenance coupling with `LOG_LEVEL` for no benefit.

  ### Fix 2: Fix ALL THREE `_classify_background()` closures

  There are three identical fire-and-forget classification closures with the same bugs:

  1. `api/menos/routers/youtube.py` — `ingest_video` endpoint (~line 256)
  2. `api/menos/routers/youtube.py` — `upload_transcript` endpoint (~line 385)
  3. `api/menos/routers/content.py` — `upload_content` endpoint (~line 228)

  Apply these changes to ALL THREE closures:

  ```python
  async def _classify_background():
      try:
          result = await classification_service.classify_content(
              content_id=content_id,
              content_text=...,
              content_type=...,
              title=...,
          )
          if result:
              await surreal_repo.update_content_classification(
                  content_id, result.model_dump()
              )
              logger.info(
                  "Classification complete for %s: tier=%s score=%d",
                  content_id, result.tier, result.quality_score,
              )
          else:
              await surreal_repo.update_content_classification_status(
                  content_id, "failed"
              )
              logger.warning("Classification returned no result for %s", content_id)
      except asyncio.CancelledError:
          logger.warning("Classification cancelled for %s (shutdown?)", content_id)
          try:
              await surreal_repo.update_content_classification_status(
                  content_id, "failed"
              )
          except Exception:
              pass
          raise  # Re-raise to properly cancel the task
      except Exception as e:
          logger.error(
              "Background classification failed for %s: %s", content_id, e, exc_info=True
          )
          try:
              await surreal_repo.update_content_classification_status(
                  content_id, "failed"
              )
          except Exception as inner_e:
              logger.error(
                  "Failed to mark classification as failed for %s: %s",
                  content_id, inner_e,
              )
  ```

  Key changes from original code:
  - Add `logger.info` on success path
  - Add `logger.warning` when result is None
  - Add `except asyncio.CancelledError` handler (it's `BaseException`, not caught by
    `except Exception`) — marks "failed" and re-raises
  - Upgrade outer exception from `logger.warning` to `logger.error` with `exc_info=True`
  - Replace inner `except Exception: pass` with logged exception

  **Important**: The `content.py` closure may use different variable names (e.g.,
  `content_text` instead of `transcript.full_text`). Read each file carefully before editing.
  `import asyncio` will need to be added to `content.py` if not already present.

  ### Fix 3: Add background task tracking and shutdown drain

  Background tasks created with `asyncio.create_task()` currently discard the task reference.
  This has two problems:
  - Tasks can theoretically be garbage collected (Python docs warning)
  - No way to await them during shutdown, leaving "pending" zombie records

  Add a module-level task tracking set. The simplest approach is to add it directly in
  `main.py` and import it where needed:

  ```python
  # In main.py
  import asyncio

  background_tasks: set[asyncio.Task] = set()
  ```

  At each `asyncio.create_task()` call site (all three closures), replace:
  ```python
  asyncio.create_task(_classify_background())
  ```
  with:
  ```python
  from menos.main import background_tasks

  task = asyncio.create_task(_classify_background())
  background_tasks.add(task)
  task.add_done_callback(background_tasks.discard)
  ```

  **Watch for circular imports.** If importing from `main.py` into routers causes a circular
  import, create a small `menos/tasks.py` module instead to hold the set.

  Add shutdown drain in the lifespan handler:
  ```python
  @asynccontextmanager
  async def lifespan(app: FastAPI):
      run_migrations()
      yield
      if background_tasks:
          logger.info("Waiting for %d background task(s)...", len(background_tasks))
          done, pending = await asyncio.wait(background_tasks, timeout=30.0)
          for t in pending:
              t.cancel()
  ```

- **Acceptance Criteria**:
  - [ ] `menos` namespace logger configured in `main.py` (NOT `basicConfig`)
  - [ ] `LOG_LEVEL` env var controls the log level (default: INFO)
  - [ ] Dockerfile CMD is NOT modified (left as-is)
  - [ ] All three `_classify_background()` closures have proper logging
  - [ ] All three closures catch `asyncio.CancelledError` separately from `Exception`
  - [ ] No bare `except: pass` remains in any background task
  - [ ] `exc_info=True` on error-level exception logs
  - [ ] Background task references stored in a set with `add_done_callback(discard)`
  - [ ] Lifespan shutdown awaits pending background tasks (30s timeout)
  - [ ] No circular import issues
  - [ ] Existing tests still pass
  - [ ] Ruff lint passes
- **Verification Command**: `cd api && uv run ruff check menos/ && uv run pytest tests/unit/ -v`

### Task 2: Validate implementation
- **Owner**: pipeline-logging-validator
- **Blocked By**: Task 1
- **Description**: Run linters, tests, and content checks on the builder's output.
  Verify that:
  1. `uv run ruff check menos/` passes with zero warnings
  2. `uv run ruff check scripts/` passes with zero warnings
  3. `uv run pytest tests/unit/ -v` passes (no smoke tests)
  4. No debug statements (`print()`, `breakpoint()`, `pdb`) in changed files
  5. No hardcoded secrets in changed files
  6. `main.py` uses namespace logger (`logging.getLogger("menos")`), NOT `basicConfig()`
  7. All three `_classify_background()` closures in `youtube.py` AND `content.py` have:
     - `logger.info` on success
     - `logger.warning` on None result
     - `except asyncio.CancelledError` with re-raise
     - `logger.error` with `exc_info=True` on outer exception
     - No bare `except: pass` on inner exception
  8. Background task set exists and is used at all `create_task` call sites
  9. Lifespan handler has shutdown drain logic
  10. Dockerfile CMD is unchanged (no `--log-level` added)
- **Acceptance Criteria**:
  - [ ] All linters pass (zero warnings)
  - [ ] All unit tests pass
  - [ ] No debug statements or hardcoded secrets
  - [ ] Namespace logger configuration verified in main.py
  - [ ] All three background task closures verified (youtube.py + content.py)
  - [ ] Task tracking and shutdown drain verified
  - [ ] Dockerfile CMD unchanged
- **Verification Command**: `cd api && uv run ruff check menos/ scripts/ && uv run pytest tests/unit/ -v`

## Dependency Graph
Task 1 (builder) → Task 2 (validator)
