# Applied Fix Plan

| Finding | Category | Plan section(s) to edit | Edit intent | Checklist impact |
|---------|----------|-------------------------|-------------|------------------|
| Branch preflight parallel with mutations | Bug | Automation Plan, Execution Checklist, Task Breakdown, Execution Waves, Dependency Graph, Validation Contract | Split branch/tool preflight into T0 and make all mutations depend on V0 | Add T0 and V0 unchecked items; update dependencies |
| File move parallel with import updates | Bug | Execution Checklist, Task Breakdown, Execution Waves, Dependency Graph | Serialize T4 after T3/V3 so imports update after paths exist | Reorder waves and validation gates |
| npm/Pi git-install compatibility not validated | Bug | Automation Plan, Execution Waves, Success Criteria, Validation Contract | Add clean/temp npm install compatibility gate and forbid pnpm-only root assumptions | Add T6 npm compatibility task/gate |
| Package-local support overclaimed | Bug | Objective, Constraints, Handoff Notes, docs task criteria | Clarify extension-dir loading is supported only from repo checkout unless core becomes packaged dependency | No new checklist item; update acceptance text |
| False-positive grep/help checks | Bug | Automation Plan, T1/T2/T4/T5 criteria, Validation Contract | Replace `|| true`/ambiguous help smoke with failing assertions and deterministic metadata/import-test checks | No new checklist item; update criteria |
| Extension package metadata not checked | Bug | T2/T6 acceptance, Validation Contract | Require explicit root and extension package Pi metadata and existing entry files | Covered by T2/T6 |
| Tool preflight missing | Hardening | Automation Plan, Execution Waves | Add command preflight for git/node/npm/pnpm/bun/just and optional pi | Covered by T0 |
| TS-source package metadata policy ambiguous | Hardening | Constraints, T2 acceptance, Handoff Notes | State no misleading dist/main/exports unless files exist; TS-source entrypoints are authoritative | Covered by T2 |
| Rollback incomplete | Hardening | Automation Plan, Validation Contract, Handoff Notes | Add path-scoped cleanup guidance and avoid broad git clean unless user-approved | No new checklist item |
| Archive evidence weak | Hardening | Validation Contract, Execution Checklist final gate text, Success Criteria | Add git status, diff check, secret scan, evidence non-placeholder requirements | Covered by F5 |
