---
created: 2026-05-24
status: completed
completed: 2026-05-24
---

# Plan: Restructure Onclave as a Pi-installable plugin package

## Context & Motivation

Onclave is currently implemented as a Pi extension at `extensions/onclave.ts`
with supporting TypeScript code in `src/onclave/*`. The user wants the repo to
become a proper Pi-installable package while preserving current behavior. The
near-term install targets are `pi install git:...`, local `pi install`, and
`pi -e`; npm publication is explicitly deferred.

Research found that Pi package installs from git clone the repository root and
run `npm install` when a root `package.json` exists. Pi discovers package
resources through package `pi` metadata or conventional directories. Therefore
the root package must remain npm-compatible even though pnpm is preferred for
development. The repo should adopt a moderate monorepo shape: a Pi extension
package under `extensions/pi-onclave`, reusable implementation code under
`packages/core`, and documentation in `AGENTS.md` explaining future locations for
protocol schemas, services, and mobile code.

## Constraints

- Platform: Windows with Git Bash/MSYS (`MINGW64_NT-10.0-26200`).
- Shell: `/usr/bin/bash` from Git Bash.
- Language/runtime: TypeScript, Bun tests, Pi extension runtime via TypeScript.
- Current marker files: `package.json`, `tsconfig.json`, `.gitattributes`,
  `bun.lock`; no existing `.specs/` directory before the first plan draft.
- Preferred development package manager: pnpm.
- Root `package.json` must remain npm-compatible for `pi install git:...`.
- Installation target for this plan is git/local Pi install only, not npm
  publishing.
- Preserve current behavior; this is a structure/refactor plan, not a feature
  change.
- Standardize vocabulary on `onclave`; avoid introducing `coms-lan` naming.
- Use a feature branch before implementation.
- Do not create empty future service packages; document future locations in
  `AGENTS.md` only.
- Current test baseline fails without dependencies installed because
  `node_modules/` is absent and tests cannot resolve `@noble/ed25519`; setup
  must install dependencies before validation.
- Loading `extensions/pi-onclave` directly is supported only when the directory
  remains inside this repo checkout so relative imports can reach
  `packages/core`. Standalone copying/publishing of that subdirectory is
  deferred until `packages/core` becomes a real package dependency.
- Package metadata added in this plan must use TypeScript-source entrypoints. Do
  not add `main`, `exports`, `types`, or `dist` references unless the referenced
  files exist and are validated.

## Risk & Manual Gate Decision

Manual gates are exceptional. Decide based on blast radius and rollback, not
generic confidence. Be conservative for work/shared systems and data/resources
that cost money; treat personal/local GitHub repos as localized-to-user when
changes are reversible and validated.

- **Risk level:** low
- **Blast radius:** personal-local-repo
- **Rollback:** easy via git branch reset or deleting the feature branch; use
  path-scoped cleanup for generated files if dependency installs create
  untracked artifacts
- **Manual approval before action:** not required
- **Manual validation after action:** not required
- **Decision reason:** The work is a non-destructive repository refactor on a
  local personal repo. It does not touch external services, secrets, paid
  resources, production systems, or user data. Automated install/typecheck/test
  validation is sufficient.

## Alternatives Considered

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Keep flat repo and add only root `pi` metadata | Smallest diff; fastest local/git Pi install | Does not match the user's selected moderate migration or long-term PRD goals for protocol/core/services separation | Rejected for this plan; valid fallback if migration becomes too noisy |
| Moderate monorepo with `extensions/pi-onclave` and `packages/core` | Keeps migration focused; supports Pi git/local install; separates Pi integration from reusable core; aligns with PRD direction | Requires broad import updates and tsconfig/package metadata changes | **Selected** |
| Full platform monorepo with `packages/protocol`, `services/*`, and `mobile/*` now | Mirrors long-term PRDs completely | Creates empty/placeholder packages and scope creep; harder to validate in one session | Rejected: defer until features exist |
| Publishable workspace packages now | Cleaner package boundaries for npm | User explicitly deferred publication decisions; published package naming/versioning is premature | Rejected for this plan |
| Use pnpm-only package scripts and workspace dependencies | Matches dev preference | Pi git installs use npm by default, so pnpm-only behavior could break install | Rejected: root must stay npm-compatible |

## Objective

Restructure the repository so Onclave can be loaded as a proper Pi package from
repo root and can be loaded from `extensions/pi-onclave` while that directory is
inside the repo checkout. Preserve existing tests and runtime behavior. The final
state includes pnpm workspace metadata, npm-compatible root package metadata, a
standard justfile command surface, package metadata for the extension and core
source organization, and an `AGENTS.md` that documents repo structure and future
architectural boundaries.

## MVP Boundary

The MVP is a moderate structure migration that moves existing files, updates
imports, validates root npm compatibility for Pi git installs, and validates that
typecheck/tests still pass after dependency setup. It is sufficient because it
makes the current extension discoverable through Pi package metadata and creates
durable repo conventions without implementing future observer, guardrail,
OpenClaw/Hermes, service, or mobile features.

## Explicit Deferrals

- npm publication and scoped package naming for internal packages.
- Extracting `packages/protocol` and shared JSON Schema fixtures.
- Implementing observer subscriptions, SQLite migrations, mobile gateway,
  OpenClaw/Hermes adapter, Aperture guardrail service, workspace provisioner, or
  mobile app.
- Making `extensions/pi-onclave` installable as a standalone copied/published
  package outside this repo checkout.
- Converting all code to package-name imports instead of relative source imports.
- Replacing Bun tests with pnpm-native test tooling; keep existing test runner
  behavior unless a small package-script wrapper is needed.

## Project Context

- **Language**: TypeScript/JavaScript project with Pi extension runtime.
- **Test command**: currently `bun test`; plan should expose `pnpm test` and
  `just test` wrappers that run the same tests.
- **Lint command**: no lint command detected; strongest repo-wide validation is
  dependency setup, typecheck, npm compatibility check, and tests.

## Automation Plan

| Operation | Command/wrapper | Credentials | Evidence |
|-----------|-----------------|-------------|----------|
| Tool preflight | `command -v git node npm pnpm bun just` and `command -v pi || true` | none | required tools present; Pi absence noted only if Pi smoke is skipped |
| Branch preflight | `git status --short --branch && git switch -c refactor/pi-plugin-structure` | none | branch name from `git branch --show-current` |
| Setup dependencies | `just setup` or `pnpm install` | none | successful install and lockfile state |
| Move files | `mkdir -p packages/core/src extensions/pi-onclave/src && git mv src/onclave packages/core/src/onclave && git mv extensions/onclave.ts extensions/pi-onclave/src/onclave.ts` | none | `git status --short` shows intended renames |
| Update imports | deterministic text edits or a Node script; avoid unpreflighted Python/Perl | none | no stale TypeScript imports from old paths |
| Verify package metadata | Node assertions for root, extension, and core `package.json` plus existing entry files | none | command exits 0 |
| Verify npm compatibility | temp-copy or clean-worktree npm install check, e.g. `tmp=$(mktemp -d); git archive --format=tar HEAD | tar -x -C "$tmp"; (cd "$tmp" && npm install --ignore-scripts && npm run typecheck --if-present)` after metadata changes are committed/staged as appropriate, or equivalent working-tree copy excluding `node_modules` | none | npm install/typecheck exits 0 or failure recorded |
| Verify behavior | `just typecheck && just test` | none | both commands exit 0 |
| Verify extension load path | `bun test tests/onclave/extension.test.ts` plus package metadata path assertions; if a known non-interactive Pi command exists, add it to `just pi-smoke` and run it | local Pi only if available | import/registration test passes; Pi smoke evidence if available |
| Rollback | `git reset --hard HEAD` for tracked changes, then path-scoped cleanup of planned untracked artifacts such as `pnpm-lock.yaml`, `package-lock.json`, `node_modules/`, `packages/core/`, `extensions/pi-onclave/` if they are untracked; avoid broad `git clean -fd` unless explicitly approved | none | repo returns to clean branch state |

## Execution Checklist

This checklist is the durable resume ledger for `/do-it`. Every executable task,
validation gate, and final completion gate has exactly one matching checkbox.
Checked means verified complete; unchecked means pending, in-progress, blocked,
or invalidated.

`/do-it` must mark each item `[x]` immediately after that item passes its
required verification and before starting any dependent or next sequential step.
`/review-it` must preserve checked state, add unchecked items for new executable
work, and never mark implementation or validation work complete.

### Wave 0

- [x] T0: Run tool and branch preflight
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V0: Validate wave 0
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 1

- [x] T1: Add workspace and package metadata
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V1: Validate wave 1
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 2

- [x] T2: Add repo guidance and justfile command surface
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V2: Validate wave 2
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 3

- [x] T3: Move extension and core source files
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V3: Validate wave 3
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 4

- [x] T4: Update imports, scripts, tests, and TypeScript includes
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V4: Validate wave 4
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 5

- [x] T5: Update user-facing docs for new Pi install/local dev paths
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V5: Validate wave 5
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Wave 6

- [x] T6: Validate npm/Pi package compatibility and archive hygiene
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] V6: Validate wave 6
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

### Final Gates

- [x] F1: Task-specific verification complete
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] F2: Repo-wide validation complete
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] F3: Manual validation not required or completed
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] F4: Deployment validation complete or not required
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).
- [x] F5: Archive preflight complete
  - Status: completed
  - Evidence: passed during /do-it execution; see final validation summary (tool/branch preflight, acceptance commands, just setup/check, npm temp compatibility, extension test, git diff --check, secret scan).

## Task Breakdown

| # | Task | Files | Type | Model | Agent | Depends On |
|---|------|-------|------|-------|-------|------------|
| T0 | Run tool and branch preflight | 0 files | mechanical | small | git-workflow-specialist | -- |
| V0 | Validate wave 0 | -- | validation | small | validation-specialist | T0 |
| T1 | Add workspace and package metadata | 5 files: `package.json`, `pnpm-workspace.yaml`, `packages/core/package.json`, `packages/core/tsconfig.json`, `extensions/pi-onclave/package.json` | feature | medium | typescript-builder | V0 |
| V1 | Validate wave 1 | -- | validation | medium | validation-specialist | T1 |
| T2 | Add repo guidance and justfile command surface | 3 files: `AGENTS.md`, `justfile`, `extensions/pi-onclave/README.md` | feature | medium | docs-workflow-builder | V1 |
| V2 | Validate wave 2 | -- | validation | medium | validation-specialist | T2 |
| T3 | Move extension and core source files | 26+ files: `src/onclave/*` to `packages/core/src/onclave/*`, `extensions/onclave.ts` to `extensions/pi-onclave/src/onclave.ts` | mechanical | medium | typescript-builder | V2 |
| V3 | Validate wave 3 | -- | validation | medium | validation-specialist | T3 |
| T4 | Update imports, scripts, tests, and TypeScript includes | 35+ files: `extensions/pi-onclave/src/onclave.ts`, `scripts/*.ts`, `tests/onclave/*.ts`, `tsconfig.json`, package scripts | architecture | large | engineering-specialist | V3 |
| V4 | Validate wave 4 | -- | validation | large | validation-specialist | T4 |
| T5 | Update user-facing docs for new Pi install/local dev paths | 2-4 files: `README.md`, `docs/USAGE.md` if present/relevant, maybe `docs/STATUS.md` if it references old paths | feature | medium | docs-workflow-builder | V4 |
| V5 | Validate wave 5 | -- | validation | medium | validation-specialist | T5 |
| T6 | Validate npm/Pi package compatibility and archive hygiene | 0-2 files if wrappers need adjustment: `justfile`, `package.json` | feature | medium | devops-workflow-specialist | V5 |
| V6 | Validate wave 6 | -- | validation | medium | validation-specialist | T6 |

## Execution Waves

### Wave 0

**T0: Run tool and branch preflight** [small] -- git-workflow-specialist
- Description: Verify required local tools and create/switch to the feature
  branch before any file mutation. Do not require the starting working tree to be
  clean unless unrelated uncommitted changes would be overwritten.
- Files: none.
- Acceptance Criteria:
  1. [ ] Required tools are available.
     - Verify: `command -v git node npm pnpm bun just`
     - Pass: exits 0 and prints paths for all required tools.
     - Fail: stop and install or document the missing tool before mutating files.
  2. [ ] Pi CLI availability is known.
     - Verify: `command -v pi || true`
     - Pass: if present, record path; if absent, record that Pi CLI smoke checks
       are skipped and metadata/import tests are the required substitute.
     - Fail: this command must not fail the plan by itself.
  3. [ ] Feature branch is active.
     - Verify: `git branch --show-current`
     - Pass: prints `refactor/pi-plugin-structure` or another clearly named
       feature branch for this work.
     - Fail: create/switch to the feature branch before implementation.

### Wave 0 -- Validation Gate

**V0: Validate wave 0** [small] -- validation-specialist
- Blocked by: T0
- Checks:
  1. Run all T0 acceptance commands.
  2. Confirm `git branch --show-current` is not `main`.
- On failure: do not start file edits; fix preflight first.

### Wave 1

**T1: Add workspace and package metadata** [medium] -- typescript-builder
- Blocked by: V0
- Description: Add pnpm workspace metadata, root Pi metadata, and package
  metadata needed for root Pi git/local install and package-local loading from
  inside this repo checkout. Root `package.json` must remain npm-compatible and
  include `"pi": { "extensions": ["./extensions/pi-onclave/src/onclave.ts"] }`.
  Do not use `workspace:*` dependencies in root metadata used by Pi git install.
- Files: `package.json`, `pnpm-workspace.yaml`, `packages/core/package.json`,
  `packages/core/tsconfig.json`, `extensions/pi-onclave/package.json`.
- Acceptance Criteria:
  1. [ ] Root package declares Pi extension metadata.
     - Verify: `node -e "const fs=require('fs'); const p=require('./package.json'); const e='./extensions/pi-onclave/src/onclave.ts'; if(!p.pi?.extensions?.includes(e)) throw new Error('root pi metadata missing');"`
     - Pass: exits 0.
     - Fail: root Pi metadata missing or points to the old extension path.
  2. [ ] `pnpm-workspace.yaml` includes both required workspace globs.
     - Verify: `grep -Fx '  - "packages/*"' pnpm-workspace.yaml && grep -Fx '  - "extensions/*"' pnpm-workspace.yaml`
     - Pass: both commands match.
     - Fail: pnpm workspace will not discover new package layout.
  3. [ ] Extension package metadata declares its Pi entrypoint and avoids
     nonexistent build outputs.
     - Verify: `node -e "const p=require('./extensions/pi-onclave/package.json'); if(!p.pi?.extensions?.includes('./src/onclave.ts')) throw new Error('extension pi metadata missing'); for (const k of ['main','exports','types']) if (p[k] && String(JSON.stringify(p[k])).includes('dist')) throw new Error('metadata references dist');"`
     - Pass: exits 0.
     - Fail: package-local metadata is missing or references unbuilt files.

### Wave 1 -- Validation Gate

**V1: Validate wave 1** [medium] -- validation-specialist
- Blocked by: T1
- Checks:
  1. Run all T1 acceptance commands.
  2. `node -e "for (const f of ['package.json','extensions/pi-onclave/package.json','packages/core/package.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"`
     -- package JSON files are valid.
  3. Confirm root `package.json` does not use `workspace:*` dependencies.
     - Command: `! grep -R 'workspace:\*' package.json`
- On failure: create a fix task, re-run the failed checks, then re-run V1.

### Wave 2

**T2: Add repo guidance and justfile command surface** [medium] -- docs-workflow-builder
- Blocked by: V1
- Description: Add `AGENTS.md` with durable repo-structure guidance and add a
  cross-platform-conscious `justfile` as the standard command surface. Add a
  package README for `extensions/pi-onclave` documenting that package-local
  loading is supported from this repo checkout, not as a standalone copied
  package.
- Files: `AGENTS.md`, `justfile`, `extensions/pi-onclave/README.md`.
- Acceptance Criteria:
  1. [ ] `AGENTS.md` documents current and future repo boundaries.
     - Verify: `grep -F 'extensions/pi-onclave' AGENTS.md && grep -F 'packages/core' AGENTS.md && grep -F 'packages/protocol' AGENTS.md && grep -F 'services/' AGENTS.md && grep -F 'mobile/' AGENTS.md && grep -F 'onclave' AGENTS.md`
     - Pass: all commands match.
     - Fail: future agents lack enough structure context.
  2. [ ] `justfile` exposes required recipes.
     - Verify: `just --list | grep -E 'setup|test|typecheck|check|pi-local|pi-local-no-extensions'`
     - Pass: listed recipes include all required names.
     - Fail: command surface incomplete or `justfile` syntax invalid.
  3. [ ] `justfile` recipes are convenience wrappers and package scripts remain
     runnable without just.
     - Verify: `node -e "const p=require('./package.json'); for (const s of ['test','typecheck']) if(!p.scripts?.[s]) throw new Error('missing script '+s);"`
     - Pass: exits 0.
     - Fail: validation would depend solely on just despite Pi/npm constraints.

### Wave 2 -- Validation Gate

**V2: Validate wave 2** [medium] -- validation-specialist
- Blocked by: T2
- Checks:
  1. Run all T2 acceptance commands.
  2. `just --list` -- justfile parses and shows expected recipes.
  3. Cross-task integration: confirm `just pi-local` targets
     `./extensions/pi-onclave`, matching root Pi metadata.
- On failure: create a fix task, re-run affected checks, then re-run V2.

### Wave 3

**T3: Move extension and core source files** [medium] -- typescript-builder
- Blocked by: V2
- Description: Move existing source files into the new structure using `git mv`
  so history is preserved. Move `src/onclave/*` to
  `packages/core/src/onclave/*`. Move `extensions/onclave.ts` to
  `extensions/pi-onclave/src/onclave.ts`.
- Files: `src/onclave/*`, `packages/core/src/onclave/*`, `extensions/onclave.ts`,
  `extensions/pi-onclave/src/onclave.ts`.
- Acceptance Criteria:
  1. [ ] Old source locations no longer contain the primary implementation.
     - Verify: `test ! -e extensions/onclave.ts && test ! -d src/onclave`
     - Pass: command exits 0.
     - Fail: old implementation remains and may cause duplicate/ambiguous
       extension loading.
  2. [ ] New source locations contain the moved implementation.
     - Verify: `test -f extensions/pi-onclave/src/onclave.ts && test -d packages/core/src/onclave`
     - Pass: command exits 0.
     - Fail: file move incomplete.

### Wave 3 -- Validation Gate

**V3: Validate wave 3** [medium] -- validation-specialist
- Blocked by: T3
- Checks:
  1. Run all T3 acceptance commands.
  2. `git status --short` -- inspect that source changes are intended renames,
     not accidental duplicates.
- On failure: create a fix task, re-run affected checks, then re-run V3.

### Wave 4

**T4: Update imports, scripts, tests, and TypeScript includes** [large] -- engineering-specialist
- Blocked by: V3
- Description: Update all imports that referenced `src/onclave/*` or
  `extensions/onclave` to the new paths. Update root `tsconfig.json` includes and
  package scripts so `pnpm typecheck`, `pnpm test`, and just recipes validate the
  relocated files. Prefer relative imports for this plan because internal
  publishable packages are deferred.
- Files: `extensions/pi-onclave/src/onclave.ts`, `scripts/onclave-acceptance-host.ts`,
  `tests/onclave/*.ts`, `tsconfig.json`, `package.json`, package-level
  `tsconfig.json` files as needed.
- Acceptance Criteria:
  1. [ ] No TypeScript imports reference old implementation paths.
     - Verify: `! grep -R "\.\./\.\./src/onclave\|\.\./src/onclave\|extensions/onclave" tests scripts extensions packages --include='*.ts'`
     - Pass: command exits 0 with no stale import matches.
     - Fail: stale imports remain and tests/typecheck may load old paths.
  2. [ ] Root TypeScript config includes relocated packages and excludes
     generated outputs.
     - Verify: `node -e "const t=require('./tsconfig.json'); const inc=(t.include||[]).join('\n'); if(!inc.includes('packages/**/*.ts') || !inc.includes('extensions/**/*.ts')) throw new Error('missing include'); const exc=(t.exclude||[]).join('\n'); if(!exc.includes('node_modules')) throw new Error('missing node_modules exclude');"`
     - Pass: exits 0.
     - Fail: compiler may not see relocated code or may scan generated output.
  3. [ ] TypeScript compiler sees the relocated code.
     - Verify: `pnpm typecheck`
     - Pass: exits 0.
     - Fail: path, module resolution, or package metadata needs correction.
  4. [ ] Existing tests run through the dev wrapper after dependencies are
     installed.
     - Verify: `pnpm test`
     - Pass: exits 0.
     - Fail: migration broke behavior or dependencies are missing.

### Wave 4 -- Validation Gate

**V4: Validate wave 4** [large] -- validation-specialist
- Blocked by: T4
- Checks:
  1. Run all T4 acceptance commands.
  2. `pnpm install` if dependencies are not installed.
  3. `pnpm typecheck` -- exits 0.
  4. `pnpm test` -- exits 0.
  5. Cross-task integration: confirm `extensions/pi-onclave/src/onclave.ts`
     imports core code from `packages/core/src/onclave/*` and not the removed
     `src/onclave/*` path.
- On failure: create a fix task, re-run affected checks, then re-run full V4.

### Wave 5

**T5: Update user-facing docs for new Pi install/local dev paths** [medium] -- docs-workflow-builder
- Blocked by: V4
- Description: Update README and relevant usage docs so the preferred commands
  use the new package path and justfile recipes. Preserve or mention short-term
  compatibility only where it is actually supported after the migration.
- Files: `README.md`, `docs/USAGE.md` if it references old extension paths,
  `docs/STATUS.md` if needed.
- Acceptance Criteria:
  1. [ ] README documents root git/local install and local extension loading.
     - Verify: `grep -F 'pi install' README.md && grep -F 'pi -e ./extensions/pi-onclave' README.md && grep -F 'just setup' README.md && grep -F 'just test' README.md`
     - Pass: all commands match.
     - Fail: users still see only old `extensions/onclave.ts` flow.
  2. [ ] Usage docs do not recommend stale primary paths.
     - Verify: `! grep -R "extensions/onclave.ts" README.md docs`
     - Pass: no stale references. If a legacy reference is intentionally kept,
       replace this check with a documented allowlist and explain why the path is
       still valid.
     - Fail: docs point users to a removed path.
  3. [ ] Docs clarify package-local loading scope.
     - Verify: `grep -R "inside this repo checkout\|not a standalone" README.md extensions/pi-onclave/README.md AGENTS.md`
     - Pass: docs warn that `extensions/pi-onclave` is not standalone outside the
       repo yet.
     - Fail: users may try unsupported copied-subdirectory installs.

### Wave 5 -- Validation Gate

**V5: Validate wave 5** [medium] -- validation-specialist
- Blocked by: T5
- Checks:
  1. Run all T5 acceptance commands.
  2. `just --list` -- command surface remains valid.
  3. Cross-task integration: README, `AGENTS.md`, root `package.json`, and
     justfile all name the same extension path: `extensions/pi-onclave`.
- On failure: create a fix task, re-run affected checks, then re-run V5.

### Wave 6

**T6: Validate npm/Pi package compatibility and archive hygiene** [medium] -- devops-workflow-specialist
- Blocked by: V5
- Description: Prove the npm-compatible path required by Pi git installs and
  perform package-entry checks that do not rely on pnpm-only workspace behavior.
  If a known non-interactive Pi command exists locally, add/run `just pi-smoke`;
  otherwise rely on deterministic metadata assertions and the extension import
  test.
- Files: `justfile`, `package.json` only if wrappers need adjustment.
- Acceptance Criteria:
  1. [ ] Root and extension package metadata point to existing extension files.
     - Verify: `node -e "const fs=require('fs'); const root=require('./package.json'); const ext=require('./extensions/pi-onclave/package.json'); for (const [base,pkg] of [['.',root],['extensions/pi-onclave',ext]]) for (const e of pkg.pi?.extensions||[]) { const path=require('path').join(base,e); if(!fs.existsSync(path)) throw new Error('missing '+path); }"`
     - Pass: exits 0.
     - Fail: Pi package discovery will point at missing files.
  2. [ ] npm install path is compatible with root metadata.
     - Verify: run a clean temp install check such as `tmp=$(mktemp -d); tar --exclude='./node_modules' --exclude='./.git' --exclude='./.specs' -cf - . | tar -xf - -C "$tmp"; (cd "$tmp" && npm install --ignore-scripts && npm run typecheck --if-present)`
     - Pass: exits 0.
     - Fail: root package metadata or scripts rely on pnpm-only behavior and may
       fail under `pi install git:...`.
  3. [ ] Extension entry can be imported/registered by existing tests.
     - Verify: `bun test tests/onclave/extension.test.ts`
     - Pass: exits 0.
     - Fail: moved extension entry or imports are unloadable.
  4. [ ] Archive hygiene checks are clean.
     - Verify: `git diff --check && git status --short`
     - Pass: no whitespace errors and status contains only intended source,
       package, docs, and lockfile changes.
     - Fail: fix whitespace or remove unintended generated/local files before
       completion.

### Wave 6 -- Validation Gate

**V6: Validate wave 6** [medium] -- validation-specialist
- Blocked by: T6
- Checks:
  1. Run all T6 acceptance commands.
  2. `just check` -- exits 0.
  3. `git diff --check` -- exits 0.
  4. Secret scan changed files with a targeted grep for common high-risk tokens:
     collect both unstaged and staged paths with
     `{ git diff --name-only; git diff --cached --name-only; } | sort -u`, then
     inspect changed text for `AKIA`, `ghp_`, `sk-ant-`, `sk-proj-`,
     `BEGIN OPENSSH`, `API_KEY=`, `TOKEN=`, and `PASSWORD=`.
  5. Confirm no generated directories such as `node_modules/`, `.pi/` runtime
     state, or temp install directories are staged or left under repo paths.
- On failure: create a fix task, re-run affected checks, then re-run V6.

## Dependency Graph

```text
Wave 0: T0 -> V0
Wave 1: V0 -> T1 -> V1
Wave 2: V1 -> T2 -> V2
Wave 3: V2 -> T3 -> V3
Wave 4: V3 -> T4 -> V4
Wave 5: V4 -> T5 -> V5
Wave 6: V5 -> T6 -> V6
Final: V6 -> F1 -> F2 -> F3 -> F4 -> F5
```

## Success Criteria

1. [ ] Repo has the intended moderate monorepo structure.
   - Verify: `test -f extensions/pi-onclave/src/onclave.ts && test -d packages/core/src/onclave && test -f pnpm-workspace.yaml && test -f AGENTS.md && test -f justfile`
   - Pass: command exits 0.
2. [ ] Pi package metadata points at the new extension entry from both root and
   repo-local extension package metadata.
   - Verify: `node -e "const fs=require('fs'); const root=require('./package.json'); const ext=require('./extensions/pi-onclave/package.json'); if(!root.pi?.extensions?.includes('./extensions/pi-onclave/src/onclave.ts')) throw new Error('root metadata'); if(!ext.pi?.extensions?.includes('./src/onclave.ts')) throw new Error('extension metadata'); if(!fs.existsSync('./extensions/pi-onclave/src/onclave.ts')) throw new Error('missing entry');"`
   - Pass: command exits 0.
3. [ ] Existing behavior remains validated by automated checks.
   - Verify: `just setup && just check`
   - Pass: setup completes, typecheck passes, and tests pass.
4. [ ] Root npm compatibility required by Pi git installs is validated.
   - Verify: run the clean temp `npm install --ignore-scripts` check from T6.
   - Pass: exits 0.
5. [ ] Docs and agent guidance explain how to work in the new structure.
   - Verify: `grep -F 'packages/core' AGENTS.md && grep -F 'extensions/pi-onclave' AGENTS.md && grep -F 'justfile' AGENTS.md && grep -F 'pnpm' AGENTS.md && grep -F 'onclave' README.md`
   - Pass: new structure and workflows are discoverable.

## Validation Contract

`/do-it` must satisfy this contract before reporting the plan complete or
archiving it.

### Automation completeness

- Required: yes
- `/do-it` must be able to run all agent-runnable validation/deployment steps
  through documented commands, scripts, playbooks, or wrappers.
- If credentials are required, the plan must define a gitignored/local credential
  path or an explicit user-approved auth mode. No credentials are required for
  this plan.
- Manual-only steps must be justified and include exact user actions plus
  expected success signals. No manual-only steps are required.

### Required automated validation

1. [ ] Run the strongest repo-wide validation command set for this project.
   - Command: `just setup && just check`
   - Pass: exits 0 with no typecheck or test failures.
   - Fail: do not archive; update execution status with the failing command and
     next fix.

2. [ ] Run npm compatibility validation for Pi git-install assumptions.
   - Command: the clean temp `npm install --ignore-scripts` check from T6.
   - Pass: exits 0.
   - Fail: do not archive; root package metadata is not safe for `pi install
     git:...`.

3. [ ] Run task-specific verification from every acceptance criterion above.
   - Command: see each task's `Verify:` command.
   - Pass: every acceptance criterion passes as written.
   - Fail: create/fix a task, rerun affected checks, then rerun repo-wide
     validation.

4. [ ] Verify extension load path through deterministic checks.
   - Command: `bun test tests/onclave/extension.test.ts` plus package metadata
     path assertions from T6.
   - Pass: extension imports/registers in the existing test and metadata points
     at existing files.
   - Fail: fix moved extension entry/imports/metadata before archive.

Do not require exact test function names, exhaustive evidence files, or
audit-grade traceability unless those tests/scripts already exist or the user
explicitly requested that rigor.

### Manual validation

Manual validation is exceptional. It should be `Required: no` unless the plan
includes destructive operations, data-loss risk, irreversible external side
effects, shared/work production impact, paid/billing/data-costing resources,
secret exposure risk, hardware/physical checks, or genuinely subjective user
judgment that cannot be replaced by safe automation.

- Required: no
- Justification: Automated validation is sufficient for this local, reversible
  repository refactor.
- Steps:
  1. None.

If manual validation is not required, `/do-it` may mark the manual gate complete
after recording why automated evidence is sufficient.

### Deployment validation

- Required: no
- Procedure: None. This plan does not deploy to external systems. Local Pi load
  checks are task-specific validation, not deployment.

If deployment is required by a later scope change and is skipped, cancelled, or
fails, `/do-it` must not archive the plan.

### Archive rule

`/do-it` may archive this plan only after all required automated validation,
task-specific verification, exceptional manual validation (if required),
deployment validation, and repo-wide validation pass. F5 requires:

1. every task, validation gate, and final gate checklist item is checked only
   after its verification has passed;
2. every Evidence field has a non-placeholder summary or command/result pointer;
3. `git diff --check` passes;
4. `git status --short` shows only intended changes;
5. changed files have been scanned for common secret/token/private-key patterns;
6. generated directories and local runtime state are not staged.

Do not require manual validation merely to increase confidence in
non-destructive behavior that automated checks already cover.

## Handoff Notes

- Start implementation by creating a feature branch, for example
  `git switch -c refactor/pi-plugin-structure`.
- Use `pnpm install` or `just setup` before test validation; the initial checkout
  may have no `node_modules/`, so tests fail before setup with missing
  `@noble/ed25519`.
- Keep root package installable by npm for Pi git installs even though pnpm is
  preferred locally.
- Prefer `git mv` for source relocation to preserve history.
- Treat `packages/core` as a source organization boundary for this plan, not a
  published package boundary.
- Treat `extensions/pi-onclave` package-local loading as repo-local only until
  `packages/core` becomes a resolvable dependency.
- If a real non-interactive Pi command is discovered, add it to `just pi-smoke`
  and include it in T6. Do not rely on `--help` as proof that the extension
  loaded.
- Do not commit unless explicitly requested by the user or by a later `/do-it`
  flow that includes final local commit instructions; do not push without an
  explicit push request.

## Execution Status

- Status: completed-and-archived candidate
- Last updated: 2026-05-24
- Last completed wave/gate: F5 Archive preflight complete
- Next wave/gate: none
- Implemented: repository restructured into `extensions/pi-onclave` and `packages/core`, package/workspace metadata added, justfile and AGENTS guidance added, imports/tests/docs updated.
- Validation passed: tool/branch preflight; all task-specific acceptance checks; `pnpm install`; `pnpm typecheck`; `pnpm test`; `bun test tests/onclave/extension.test.ts`; `just check`; clean temp `npm install --ignore-scripts && npm run typecheck --if-present`; `git diff --check`; changed-file secret scan.
- Manual validation: not required; automated evidence is sufficient for this local reversible refactor.
- Deployment validation: not required; no external deployment in scope.
- Archive: ready; archive preflight passed.
