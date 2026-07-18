---
created: 2026-02-11
completed: 2026-02-11
---

# Team Plan: Update Remaining Unified Pipeline Workstream Plans

## Objective
Review and update WS4 (Router/API Cutover), WS5 (Observability + Retention + Cleanup), and WS6 (Validation + Release Readiness) with accurate codebase references from WS1-WS3 implementation. Each plan needs precise file paths, function signatures, service dependencies, and detailed acceptance criteria grounded in what was actually built.

## Project Context
- **Language**: Python 3.12+
- **Test command**: `cd api && uv run pytest tests/unit/ -v`
- **Lint command**: `cd api && uv run ruff check menos/`

## Key Codebase Facts (from WS1-WS3 Analysis)

### What WS1-WS3 Built
- `unified_pipeline.py` — `UnifiedPipelineService.process()`, `parse_unified_response()`
- `llm_json.py` — `extract_json()` shared utility
- `models.py` — `UnifiedResult`, `PipelineJob`, `JobStatus`, `DataTier` enums
- `config.py` — `unified_pipeline_enabled/provider/model/max_concurrency`, `app_version` property
- `di.py` — `get_unified_pipeline_provider()`, `get_unified_pipeline_service()`
- `storage.py` — `update_content_processing_status()`, `update_content_processing_result()`
- `jobs.py` — `JobRepository` with `create_job()`, `get_job()`, `find_active_job_by_resource_key()`, `update_job_status()`, `list_jobs()`
- `resource_key.py` — `normalize_url()`, `generate_resource_key()`
- `health.py` — `/health` returns `app_version`
- Migrations: `unified_status.surql` (processing_status/processed_at/pipeline_version on content), `pipeline_job.surql`
- Tests: `test_unified_parser.py`, `test_unified_pipeline.py`

### What Still Uses Old Dual-Task Model
- `routers/youtube.py` — fires background tasks for classification + entity extraction separately
- `routers/content.py` — same dual background tasks
- `routers/classification.py` — manual classification via ClassificationService
- `scripts/classify_content.py` — batch classification via old status fields
- `scripts/reprocess_content.py` — entity reprocessing via old status fields
- `scripts/export_summaries.py` — queries classification_status/tier/score
- `storage.py` — still has `update_content_classification_status()`, `update_content_classification()`, `update_content_extraction_status()`

### Routers Not in Original Plan
- `routers/classification.py` — manual classify endpoint (needs cutover or removal in WS4)
- `routers/entities.py` — entity CRUD (stays, no status field usage)

## Complexity Analysis

| Task | Est. Files | Change Type | Model | Agent |
|------|-----------|-------------|-------|-------|
| Update WS4 plan | 1 | feature (substantial rewrite) | sonnet | builder |
| Update WS5 plan | 1 | feature (substantial rewrite) | sonnet | builder |
| Update WS6 plan | 1 | feature (substantial rewrite) | sonnet | builder |

## Team Members

| Name | Agent | Model | Role |
|------|-------|-------|------|
| ws-plan-builder-1 | builder | sonnet | Update WS4 plan |
| ws-plan-builder-2 | builder | sonnet | Update WS5 plan |
| ws-plan-builder-3 | builder | sonnet | Update WS6 plan |
| ws-plan-validator | validator-heavy | sonnet | Validate all 3 plans for accuracy and consistency |

## Execution Waves

### Wave 1 (parallel)
- T1: Update WS4 plan with accurate codebase references [sonnet] — builder
- T2: Update WS5 plan with accurate codebase references [sonnet] — builder
- T3: Update WS6 plan with accurate codebase references [sonnet] — builder

### Wave 1 Validation
- V1: Validate all 3 updated plans [sonnet] — validator-heavy, blockedBy: [T1, T2, T3]

## Task Details

### T1: Update WS4 — Router/API Cutover

Update `.specs/unified-pipeline-phase2/ws4-routers.md` with:

1. **Accurate "Current State" section** documenting exactly how youtube.py and content.py work today (background tasks, classification_service, entity_resolution_service calls, status fields)
2. **Account for classification.py router** — not in original plan, needs cutover or removal
3. **Precise task breakdowns** with file paths, function signatures, and what each task creates/modifies
4. **Scripts section** with actual script analysis (classify_content.py uses classification_status, reprocess_content.py uses entity_extraction_status, export_summaries.py queries classification fields)
5. **Reference actual WS1-WS3 artifacts** — `UnifiedPipelineService`, `JobRepository`, `PipelineJob`, `generate_resource_key()`, DI functions
6. **Execution waves** with parallel/sequential structure and validation gates
7. **Acceptance criteria** per task that reference actual function names and models

Acceptance Criteria:
- [ ] All file paths reference actual existing files
- [ ] Function signatures match current codebase
- [ ] Tasks account for classification.py router (not in original plan)
- [ ] Each task has concrete acceptance criteria
- [ ] Dependency chain is accurate (builds on what WS1-WS3 actually created)
- [ ] Execution waves are defined with validation gates
- [ ] "Files NOT to Touch" section prevents scope creep

### T2: Update WS5 — Observability + Retention + Cleanup

Update `.specs/unified-pipeline-phase2/ws5-observability.md` with:

1. **Accurate dependency list** — what from WS4 must exist before WS5 can start
2. **Legacy code inventory** — list all old methods/fields to remove: `update_content_classification_status()`, `update_content_classification()`, `update_content_extraction_status()`, `classification_status`/`entity_extraction_status` DB fields, `ClassificationResult` model (if no longer needed), old ClassificationService calls
3. **Graph endpoint analysis** — current state of graph.py queries (no status field references found)
4. **Concrete observability tasks** — where to add correlation IDs (unified_pipeline.py stages), what metrics to track (job duration from started_at to finished_at, LLM token usage if available)
5. **Retention implementation** — purge queries against pipeline_job table using data_tier and finished_at
6. **Execution waves** with proper structure
7. **Dead code checklist** — exact functions/methods/fields to remove

Acceptance Criteria:
- [ ] Legacy code inventory is complete and references actual function names
- [ ] Observability additions reference actual pipeline stages in unified_pipeline.py
- [ ] Retention purge queries reference actual pipeline_job fields (data_tier, finished_at)
- [ ] Graph endpoint task reflects actual current state (no status field changes needed unless WS4 changes queries)
- [ ] Each task has acceptance criteria
- [ ] Execution waves defined with validation gates

### T3: Update WS6 — Validation + Release Readiness

Update `.specs/unified-pipeline-phase2/ws6-validation.md` with:

1. **Comprehensive verification checklist** grounded in actual codebase state
2. **Smoke test plan** — what to test against live deployment
3. **Doc update inventory** — exact files to update (docs/ingest-pipeline.md, docs/schema.md if exists, .claude/rules/architecture.md, .claude/rules/schema.md)
4. **Grep-based verification** — commands to verify no old terminology remains (classification_status, entity_extraction_status, labels vs tags)
5. **Spec creation** — what goes in docs/specs/unified-pipeline.md
6. **Definition of Done** aligned with master plan.md

Acceptance Criteria:
- [ ] Verification commands are concrete and runnable
- [ ] Doc update list references actual existing files
- [ ] Grep checks cover all old terminology
- [ ] Definition of Done matches master plan.md exactly
- [ ] Smoke test plan references actual endpoints

### V1: Validate All Plans

Review all 3 updated plans for:
1. **Cross-plan consistency** — no contradictions between WS4, WS5, WS6
2. **Codebase accuracy** — spot-check file references, function names, model names against actual code
3. **Dependency chain** — WS4 → WS5 → WS6 ordering makes sense
4. **No scope overlap** — each workstream has clear boundaries
5. **Master plan alignment** — all tasks from plan.md are covered

## Dependency Graph
Wave 1: T1, T2, T3 (parallel) → V1
