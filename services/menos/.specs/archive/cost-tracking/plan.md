---
created: 2026-02-11
completed:
---

# Team Plan: LLM Cost Tracking

## Objective

Track every LLM API call with token counts, cost estimates, duration, and context. Enable cost visibility and budget monitoring for content processing pipeline and agentic search features.

## Project Context

- **Language**: Python 3.12+ (FastAPI, Pydantic, SurrealDB)
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`
- **Key files**:
  - `api/menos/services/llm.py` — LLMProvider protocol
  - `api/menos/services/llm_providers.py` — Cloud provider implementations
  - `api/menos/services/unified_pipeline.py` — Content processing (uses LLM)
  - `api/menos/services/agent.py` — Agentic search (uses LLM)
  - `api/menos/services/di.py` — Dependency injection wiring
  - `api/menos/services/storage.py` — SurrealDB repository

## Background

Current state:
- LLM calls happen in unified pipeline (tags, summary, entities) and agentic search (expansion, synthesis)
- Unified pipeline estimates tokens: `len(prompt) // 4 + len(response) // 4`
- No cost tracking, no visibility into API spend
- Providers: OpenAI, Anthropic, OpenRouter, Ollama, FallbackProvider, NoOp

Target state:
- Every `generate()` call logged to SurrealDB with token counts, cost, duration, context
- `GET /api/v1/usage` endpoint with date range and provider filters
- Cost estimates use a hybrid pricing snapshot model (daily refresh + persisted snapshot)
- Context strings identify call source: `pipeline:{job_id}`, `search:expansion`, `search:synthesis`
- All application LLM calls cross a single architecture boundary: DI-provided metered wrappers (no direct raw provider calls in feature code)

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| T1: Schema migration for llm_usage | 1 | New migration | Sonnet | builder |
| T2: Pricing snapshot service | 2 | New module + storage integration | Sonnet | builder |
| T3: Metering decorator | 1 | New service | Sonnet | builder |
| T4: DI + scheduler integration | 2 | Modify | Sonnet | builder |
| T5: Usage router endpoint | 2 | New router | Sonnet | builder |
| T6: Unit tests | 3 | New tests | Sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| Schema Builder | builder | Sonnet 4.5 | Create llm_usage table migration |
| Config Builder | builder | Sonnet 4.5 | Implement pricing snapshot refresh + persistence |
| Metering Builder | builder | Sonnet 4.5 | Implement metering with immutable per-call pricing capture |
| DI Builder | builder | Sonnet 4.5 | Wire metering and in-process scheduler lifecycle |
| API Builder | builder | Sonnet 4.5 | Create usage endpoint, totals, and staleness metadata |
| Test Builder | builder | Sonnet 4.5 | Write unit tests for metering + endpoint |

## Execution Waves

### Wave 1: Infrastructure
**Dependencies**: None

- **T1: Create llm_usage table migration** [Sonnet] — Schema Builder
  - Create `api/migrations/YYYYMMDD-HHMMSS_llm_usage_table.surql`
  - Define `llm_usage` table with fields:
    - `provider: string` — Provider name (openrouter, openai, anthropic, ollama, etc.)
    - `model: string` — Full model identifier (openrouter/aurora-alpha, gpt-4o-mini, etc.)
    - `input_tokens: int` — Estimated input token count
    - `output_tokens: int` — Estimated output token count
    - `input_price_per_million: float` — Captured input-side USD price at call time
    - `output_price_per_million: float` — Captured output-side USD price at call time
    - `estimated_cost: float` — USD cost estimate computed from captured prices
    - `context: string` — Call context (pipeline:JOB_ID, search:expansion, search:synthesis)
    - `duration_ms: int` — Call duration in milliseconds
    - `pricing_snapshot_refreshed_at: datetime` — Snapshot timestamp used for this call
    - `created_at: datetime` — Timestamp (default time::now())
  - Add index on `created_at` for efficient date range queries
  - Follow existing migration pattern from `20260211-120100_pipeline_job.surql`

  **Acceptance Criteria**:
  - Migration file exists with correct naming convention
  - All fields defined with correct types
  - Immutable pricing fields are present in `llm_usage`
  - Index on `created_at` field
  - Migration runs successfully: `cd api && uv run python scripts/migrate.py`

- **T2: Implement pricing snapshot service (hybrid model)** [Sonnet] — Config Builder
  - Create `api/menos/services/llm_pricing.py`
  - Implement persisted pricing snapshot in SurrealDB as authoritative source for runtime reads
  - Implement scheduled refresh policy that updates snapshot daily (every 24 hours) and persists last-good snapshot
  - Include bootstrap defaults used only when no snapshot exists yet
  - Expose `get_model_pricing(provider: str, model: str) -> dict[str, float]` backed by the latest persisted snapshot
  - Expose snapshot metadata: `refreshed_at`, `is_stale` (true when snapshot age exceeds 7 days), `age_seconds`, `source`
  - Unknown models return `{"input": 0.0, "output": 0.0}` and are still logged safely

  **Acceptance Criteria**:
  - Runtime price lookup reads from persisted SurrealDB snapshot
  - Scheduled refresh runs daily (every 24 hours), updates snapshot, and retains last-good snapshot on refresh failure
  - Snapshot metadata is available to callers
  - Snapshot is marked stale when `refreshed_at` is older than 7 days
  - Function returns correct pricing for known models from snapshot
  - Unknown models return zero cost without raising
  - Unit tests verify refresh behavior, fallback to last-good snapshot, and lookup behavior

- **T3: Implement LLM metering decorator** [Sonnet] — Metering Builder
  - Create `api/menos/services/llm_metering.py`
  - Implement `MeteringLLMProvider` class:
    - Wraps any `LLMProvider` instance
    - Intercepts `generate()` calls
    - Measures duration with `time.perf_counter()`
    - Estimates tokens: `len(prompt) // 4` for input, `len(response) // 4` for output
    - Looks up pricing from the current persisted snapshot
    - Captures immutable `input_price_per_million` and `output_price_per_million` in each usage row
    - Writes record to `llm_usage` table via `SurrealDBRepository`
    - Returns original response unchanged (pass-through)
  - Constructor accepts: `provider: LLMProvider, repo: SurrealDBRepository, context_prefix: str, provider_name: str, model_name: str`
  - Implement `async def close()` that calls wrapped provider's close
  - Write usage record asynchronously (don't block response)

  **Acceptance Criteria**:
  - Decorator implements `LLMProvider` protocol
  - `generate()` calls wrapped provider and logs usage
  - Token estimation uses `len(text) // 4` formula
  - Cost calculated from captured per-call price fields
  - Usage rows remain cost-reproducible even if future snapshots change
  - Duration captured in milliseconds
  - Context string includes prefix (e.g., "pipeline:abc123")
  - Unit tests with mocked DB verify logging behavior
  - No exceptions raised if DB write fails (log error and continue)

### Wave 2: Integration & API
**Dependencies**: [T1, T2, T3]

- **T4: Wire metering + scheduler into app lifecycle** [Sonnet] — DI Builder
  - Modify `api/menos/services/di.py`
  - Modify `api/menos/main.py` lifespan startup/shutdown hooks
  - Update `.claude/CLAUDE.md` with an explicit rule: all feature LLM `generate()` calls must go through DI-provided metered wrappers (no direct raw provider usage)
  - Wrap providers in `get_expansion_provider()`, `get_synthesis_provider()`, `get_unified_pipeline_provider()` with `MeteringLLMProvider`
  - Pass appropriate context prefixes: `"search:expansion"`, `"search:synthesis"`, `"pipeline"`
  - For unified pipeline, update `UnifiedPipelineService` to pass job_id to metering context: `"pipeline:{job_id}"`
  - Extract provider name and model from wrapped provider for metering constructor
  - Don't wrap `NoOpLLMProvider` (no metering for no-op)
  - Start in-process daily pricing refresh scheduler during API lifespan startup
  - Stop scheduler cleanly during API lifespan shutdown
  - Assume a single API instance (no distributed lock or leader election in this phase)
  - Enforce architecture boundary: application feature code obtains LLM access via DI-provided metered wrappers only (no direct raw provider usage)

  **Acceptance Criteria**:
  - All LLM providers (except NoOp) wrapped with metering
  - Application LLM entrypoints use DI-provided metered wrappers as the only call path
  - `.claude/CLAUDE.md` includes the architecture-boundary rule for future feature work
  - Context strings correctly identify call source
  - Pipeline context includes job_id for granular tracking
  - Exactly one in-process scheduler runs per API process lifespan
  - No distributed lock mechanism is introduced
  - Existing functionality unchanged (pass-through behavior)
  - No circular dependencies in DI wiring

- **T5: Create usage reporting endpoint** [Sonnet] — API Builder
  - Create `api/menos/routers/usage.py`
  - Define `UsageQuery` model:
    - `start_date: datetime | None = None`
    - `end_date: datetime | None = None`
    - `provider: str | None = None`
    - `model: str | None = None`
  - Define `UsageResponse` model:
    - `total_calls: int`
    - `total_input_tokens: int`
    - `total_output_tokens: int`
    - `estimated_total_cost: float`
    - `breakdown: list[dict]` — Per-provider/model breakdown with counts and costs
    - `pricing_snapshot: dict` — Staleness metadata (`refreshed_at`, `is_stale` where stale means older than 7 days, `age_seconds`, `source`)
  - Implement `GET /api/v1/usage` endpoint:
    - Accepts query params: `start_date`, `end_date`, `provider`, `model`
    - Queries `llm_usage` table with WHERE filters
    - Aggregates: SUM(input_tokens), SUM(output_tokens), SUM(estimated_cost), COUNT(*)
    - Groups by provider + model for breakdown
    - Includes current pricing snapshot staleness metadata in response
    - Continues serving with last-good snapshot metadata when pricing refresh is stale or failed
  - Requires RFC 9421 auth
  - Register router in `api/menos/main.py`

  **Acceptance Criteria**:
  - Endpoint returns correct aggregated totals
  - Date range filtering works (inclusive bounds)
  - Provider/model filters work
  - Breakdown includes per-provider and per-model stats
  - Response always includes pricing snapshot staleness metadata
  - Stale snapshot state is surfaced without failing the endpoint
  - Auth required
  - Response follows UsageResponse schema
  - Endpoint documented in `.claude/rules/api-reference.md`

### Wave 3: Testing
**Dependencies**: [T1, T2, T3, T4, T5]

- **T6: Comprehensive unit tests** [Sonnet] — Test Builder
  - Create `api/tests/unit/test_llm_metering.py`:
    - Test metering decorator intercepts calls
    - Test token estimation accuracy
    - Test cost calculation for various models
    - Test DB write on successful generation
    - Test error handling (DB write fails, provider fails)
    - Test context string formatting
  - Create `api/tests/unit/test_llm_pricing.py`:
    - Test pricing lookup for all known models from persisted snapshot
    - Test scheduled daily refresh success path
    - Test refresh failure keeps last-good snapshot available
    - Test staleness threshold marks snapshots stale only after 7 days
    - Test unknown model returns zero cost
  - Create `api/tests/unit/test_usage_router.py`:
    - Test usage endpoint with mocked DB
    - Test date range filtering
    - Test provider/model filtering
    - Test aggregation logic
    - Test empty results case
    - Test staleness metadata in response (fresh and stale cases)
  - Add DI architecture-boundary tests:
    - Verify DI provider factories return metered wrappers for all active LLM entrypoints
    - Verify feature services (`UnifiedPipelineService`, `AgentService`) receive wrapped providers, not raw provider instances
  - All tests must pass with zero warnings

  **Acceptance Criteria**:
  - Test coverage >80% for new modules
  - All edge cases covered (empty data, invalid dates, etc.)
  - Mock DB operations (no live DB in unit tests)
  - Tests pass: `cd api && uv run pytest tests/unit/test_llm_*.py tests/unit/test_usage_router.py -v`
  - No warnings from pytest or ruff

## Dependency Graph

```
T1 (Schema) ───┐
               │
T2 (Pricing) ──┼──> T3 (Metering) ──┬──> T4 (DI+Scheduler) ──┐
               │                     │              ├──> T6 (Tests)
               │                     └──> T5 (API) ─┘
               │
               └──> (blocks all downstream)
```

## Implementation Notes

### Token Estimation Formula
Use `len(text) // 4` for both input and output. This is a rough approximation (1 char ≈ 0.25 tokens). Acceptable for cost tracking purposes. Real token counts from API responses would require provider-specific parsing.

### Pricing Table Updates
Pricing strategy uses a hybrid snapshot model. Refresh runs daily (every 24 hours) and writes a persisted snapshot to SurrealDB. Runtime reads use the persisted snapshot as authoritative; when refresh fails, keep serving the last-good snapshot. Mark metadata as stale when snapshot age exceeds 7 days.

### Context String Format
- Unified pipeline: `"pipeline:{job_id}"` (e.g., `"pipeline:pipeline_job:abc123"`)
- Search expansion: `"search:expansion"`
- Search synthesis: `"search:synthesis"`

### Metering Error Handling
DB write failures should NOT break LLM calls. Log error, emit warning, continue. This ensures metering doesn't become a single point of failure.

### Scheduler Ownership and Instance Model
Pricing refresh scheduler is owned by API process lifespan (startup/shutdown). Current deployment assumption is a single API instance, so no distributed locking is required in this phase.

### FallbackProvider Metering
`FallbackProvider` tries multiple providers in sequence. Each sub-provider should be individually metered. Wrap each provider in the fallback chain, not the `FallbackProvider` itself.

### LLM Architecture Boundary
Treat DI-provided metered wrappers as the only sanctioned application boundary for `generate()` calls. New features must integrate through DI wrappers instead of invoking raw provider implementations directly.

### Cost Calculation
```python
cost = (input_tokens / 1_000_000) * input_price + (output_tokens / 1_000_000) * output_price
```

`input_price` and `output_price` must be copied into each `llm_usage` row as immutable per-call values for reproducibility.

### SurrealDB Query Pattern
```python
# Aggregation query example
query = """
SELECT
  count() AS total_calls,
  math::sum(input_tokens) AS total_input_tokens,
  math::sum(output_tokens) AS total_output_tokens,
  math::sum(estimated_cost) AS estimated_total_cost
FROM llm_usage
WHERE created_at >= $start AND created_at <= $end
  AND provider = $provider
"""
```

## Success Metrics

1. Every LLM call logged to `llm_usage` table
2. Every `llm_usage` row stores immutable per-call pricing fields used for cost computation
3. Pricing snapshot is persisted in SurrealDB and used as authoritative runtime source
4. Scheduled refresh runs daily (every 24 hours), updates snapshots, and preserves last-good snapshot on refresh failures
5. Usage endpoint returns totals plus staleness metadata for the active snapshot, with stale defined as snapshot age > 7 days
6. Date range and filter queries work correctly
7. No performance degradation in LLM calls (metering is async)
8. All unit tests pass with >80% coverage
9. Linter passes with no warnings
10. DI architecture-boundary tests ensure no feature path bypasses metering

## Future Extensions

- Real token counts from provider API responses (parse usage objects)
- Budget alerts (webhook when monthly cost exceeds threshold)
- Cost breakdown by content type (YouTube vs markdown)
- Grafana dashboard for cost visualization
- Token count caching (avoid re-estimating same prompts)
- Provider API key rotation tracking
- Cost attribution per user (if multi-tenant)
