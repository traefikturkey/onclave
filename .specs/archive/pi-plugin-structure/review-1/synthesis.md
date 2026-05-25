---
date: 2026-05-24
status: synthesis-complete
---

# Review: Restructure Onclave as a Pi-installable plugin package

## Review Panel
| Reviewer | Base Agent | Assigned Expert Persona | Why selected | Adversarial angle | Artifact |
|----------|------------|-------------------------|--------------|-------------------|----------|
| reviewer | reviewer | Completeness and explicitness reviewer | Mandatory standard reviewer for hidden assumptions and execution gaps | Assume a fresh `/do-it` session follows the plan literally and hits every ambiguity | `.specs/pi-plugin-structure/review-1/reviewer.md` |
| security-reviewer | security-reviewer | Operational safety and rollback reviewer | Mandatory standard reviewer for realistic breakage and safety gaps | Assume branch/rollback/package install ordering fails under normal conditions | `.specs/pi-plugin-structure/review-1/security-reviewer.md` |
| product-manager | product-manager | Scope and simplicity reviewer | Mandatory standard reviewer for MVP scope pressure | Assume the plan over-rotates on future architecture instead of current installability | `.specs/pi-plugin-structure/review-1/product-manager.md` |
| typescript-pro | typescript-pro | TypeScript package/module-resolution reviewer | The plan changes TS source layout, package metadata, and import paths | Assume local tests pass while Pi/npm/package boundary loading fails | `.specs/pi-plugin-structure/review-1/typescript-toolchain-reviewer.md` |
| devops-pro | devops-pro | Pi install and local workflow reviewer | The plan relies on Pi git/local install, npm compatibility, pnpm, just, and Windows Git Bash | Assume a fresh Windows Git Bash checkout lacks implicit tools and every ambiguous smoke command lies | `.specs/pi-plugin-structure/review-1/devops-install-reviewer.md` |
| qa-engineer | qa-engineer | Migration regression and acceptance-criteria reviewer | Behavior preservation after a broad file move depends on strong validation | Assume grep checks and help commands produce false positives | `.specs/pi-plugin-structure/review-1/qa-validation-reviewer.md` |

## Standard Reviewer Findings
### reviewer
- High: Wave 1 allowed docs/justfile edits in parallel with the branch-creation task, violating the plan's own branch-before-implementation constraint.
- High: Wave 2 allowed import updates to run in parallel with file moves, although import updates depend on final paths created by the move.
- Medium: Extension package metadata was listed but not explicitly validated for its own Pi entrypoint.
- Medium: Several grep checks used patterns that could pass on partial matches.
- Medium: Pi smoke command was ambiguous and could be non-proving.

### security-reviewer
- High: Branch preflight must be serialized before any mutating task.
- Medium: npm/Pi install compatibility was asserted but not validated through an npm-path check.
- Medium: The plan claimed both repo-root and package-local loading while using relative imports that are only safe when the extension package remains inside the repo checkout.
- Low: Archive preflight lacked concrete checks for generated/unintended staged files and command evidence.

### product-manager
- High: Package-local extension metadata and load behavior were not validated despite being part of the objective.
- Medium: The migration may be broader than strictly necessary for git/local install; root metadata alone would be a smaller MVP.
- Medium: `packages/core` as a package boundary is weak if it is still consumed by relative paths.
- Low: justfile adds a tool dependency; npm/pnpm scripts should remain sufficient for validation.
- Medium: npm-based Pi install path was not validated.

## Additional Expert Findings
### typescript-pro
- High: Loading `extensions/pi-onclave` outside the repo would fail if it imports `../../../packages/core`; the plan must narrow or implement the supported runtime boundary.
- High: npm install compatibility was not validated even though Pi git installs run npm.
- Medium: Package metadata could point to nonexistent build outputs unless the TS-source strategy is explicit.
- Medium: root tsconfig changes need explicit `packages/**/*.ts` coverage and generated-output exclusions.

### devops-pro
- High: validation used pnpm/just but not a clean npm install path.
- High: root and extension package install targets were ambiguous.
- Medium: `--help`/`--no-extensions` smoke checks may bypass extension loading.
- Medium: rollback did not cover untracked generated files or path-scoped cleanup.
- Medium: tool preflight omitted required local tools such as pnpm, bun, just, and possibly Pi.

### qa-engineer
- High: `grep ... || true` can pass even when stale imports remain.
- High: Pi smoke command can pass without loading the extension.
- Medium: extension package metadata was not checked for Pi entry.
- Medium: npm compatibility gate was missing.
- Medium: archive preflight lacked concrete evidence requirements.

## Suggested Additional Reviewers
- typescript-pro -- relevant because the plan changes TypeScript source layout, tsconfig includes, package metadata, and runtime import paths.
- devops-pro -- relevant because the plan depends on Pi git/local installation behavior, npm compatibility, pnpm dev flow, just recipes, and Windows Git Bash commands.
- qa-engineer -- relevant because this is a behavior-preserving migration where weak acceptance criteria can pass while runtime loading breaks.

## Bugs (must fix before execution)
1. Serialized execution is broken: branch creation and file moves are prerequisites but were scheduled in parallel with dependent mutating work.
2. npm/Pi git-install compatibility is not validated even though it is a core constraint.
3. The plan overclaims package-local/extension-dir support without defining that it only works from inside the repo checkout when relative imports point to `packages/core`.
4. Several acceptance commands can pass falsely (`grep ... || true`, alternation checks, and help/no-extension smoke commands).
5. Extension package metadata and root/package entrypoint existence are not explicitly checked.

## Hardening
1. Add tool preflight checks for `git`, `node`, `npm`, `pnpm`, `bun`, `just`, and optional `pi`.
2. Make package metadata policy explicit: TS-source entrypoints only, no misleading `dist`/`exports` unless implemented.
3. Add path-scoped rollback/cleanup guidance for generated or untracked files.
4. Add archive preflight requiring `git status --short`, `git diff --check`, secret scan of changed files, and non-placeholder evidence.
5. Keep justfile as a convenience wrapper while ensuring npm/pnpm scripts remain the actual validation primitives.

## Simpler Alternatives / Scope Reductions
1. A smaller MVP could add root `pi` metadata without moving `src/onclave`. This remains a valid fallback if execution discovers the moderate migration is too noisy.
2. If `packages/core` cannot be made a meaningful boundary now, the plan should treat it as a source organization boundary, not a standalone published package.
3. Avoid implementing a new Pi-specific noninteractive smoke if existing tests can import/register the extension and package metadata checks prove discovery paths.

## Automation Readiness
- Agent-runnable operational steps: Not ready as written because task dependencies and checks permit false positives. Auto-applied fixes should serialize waves and replace ambiguous checks.
- Credential/auth flow clarity: No credentials required.
- Evidence and archive gates: Need concrete archive preflight and evidence requirements before `/do-it` can decide completion.
- Manual-only steps and justification: Manual validation is correctly not required for this local reversible refactor.
- Execution checklist: Present, but must be updated to match serialized tasks and any added validation gates.

## Contested or Dismissed Findings
1. Product-manager suggested deferring `packages/core` extraction entirely. This is a legitimate simplification but not a must-fix because the user's explicit decision was a moderate migration moving current code into `packages/core`.
2. Requiring a real `pi install git:...` against a remote was not accepted as mandatory; a clean temp npm install plus metadata/extension import tests is adequate for this local plan and avoids external side effects.
3. A help-based Pi smoke was rejected as insufficient; the fix should prefer deterministic metadata and existing extension import/registration tests unless a known noninteractive Pi command exists.

## Verification Notes
1. The parallel branch/file-write issue was verified in `.specs/pi-plugin-structure/plan.md` lines showing `Wave 1: T1, T2 (parallel)` while T1 includes branch creation and T2 mutates files.
2. The parallel move/import issue was verified in the dependency graph showing `Wave 2: T3, T4 (parallel after V1)` while T4 edits files created by T3.
3. The false-positive stale-import check was verified in T4 AC1: `grep ... || true`.
4. The npm compatibility gap was verified by plan validation sections using `pnpm install`, `pnpm typecheck`, and `pnpm test` without an npm install gate.
5. The ambiguous Pi smoke was verified in Automation Plan: `just pi-local-no-extensions --help` or `pi --no-extensions -e ./extensions/pi-onclave --help`.

## Reviewer Artifact Status
| Reviewer | Artifact | Status | Notes |
|----------|----------|--------|-------|
| reviewer | `.specs/pi-plugin-structure/review-1/reviewer.md` | read | usable structured findings |
| security-reviewer | `.specs/pi-plugin-structure/review-1/security-reviewer.md` | read | usable structured findings |
| product-manager | `.specs/pi-plugin-structure/review-1/product-manager.md` | read | usable structured findings |
| typescript-pro | `.specs/pi-plugin-structure/review-1/typescript-toolchain-reviewer.md` | read | usable structured findings |
| devops-pro | `.specs/pi-plugin-structure/review-1/devops-install-reviewer.md` | read | usable structured findings |
| qa-engineer | `.specs/pi-plugin-structure/review-1/qa-validation-reviewer.md` | read | usable structured findings |

## Timing Notes
| Step | Duration | Notes |
|------|----------|-------|
| Initial review panel | unknown | 6/6 reviewers succeeded; per-reviewer timing unavailable |
| Artifact reads | unknown | all expected reviewer artifacts read |
| Recovery calls | not run | no missing or unusable artifacts |
| Verification | unknown | static plan grep/read checks used |
| Synthesis | unknown | `.specs/pi-plugin-structure/review-1/synthesis.md` |

## Auto-Apply Plan
- Applied fixes artifact: `.specs/pi-plugin-structure/review-1/applied-fixes.md`
- Known-blocker fixes artifact: `not run/no prior blockers`
- Section integrity check: passed (`grep -n '^## ' .specs/pi-plugin-structure/plan.md` confirmed required sections appear once)
- Standalone-readiness result: `STANDALONE READY`
- Repair passes used: 1 hardening pass after standalone reviewer noted a non-blocking secret-scan improvement

## Review Artifact
Wrote full synthesis to: `.specs/pi-plugin-structure/review-1/synthesis.md`

## Overall Verdict
**Ready to execute** after auto-applied plan fixes.

## Recommended Next Step
- Execute via `/do-it .specs/pi-plugin-structure/plan.md`.
