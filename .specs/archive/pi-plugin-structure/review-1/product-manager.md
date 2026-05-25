# Product Manager Review Findings

## Finding 1
severity: high
evidence: Objective requires loading “from repo root and from `extensions/pi-onclave`”, but acceptance mostly verifies root `package.json` Pi metadata and `just pi-local`. The extension package metadata is only JSON-parsed, not checked for correct `pi` metadata, dependencies, or standalone load behavior.
required_fix: Add explicit acceptance criteria for `extensions/pi-onclave/package.json`: Pi metadata points to `./src/onclave.ts`, required runtime dependencies are resolvable, and `pi -e ./extensions/pi-onclave --help` or equivalent non-interactive smoke check passes.

## Finding 2
severity: medium
evidence: The plan rejects “keep flat repo and add only root `pi` metadata” mainly because of long-term PRD goals, yet this task’s stated goal is git/local Pi install while preserving behavior. Moving 26+ files and creating packages/core expands blast radius for no current runtime feature.
required_fix: Re-scope MVP to the smallest installable shape unless there is hard evidence Pi packaging requires the move: add root `pi` metadata, create `extensions/pi-onclave` only if needed, and defer `packages/core` extraction until a non-Pi consumer exists.

## Finding 3
severity: medium
evidence: The selected design moves core code to `packages/core` but explicitly defers package-name imports and publication. That creates a workspace-looking package that is still consumed by relative paths, gaining package complexity without enforceable boundary benefits.
required_fix: Either make `packages/core` a real boundary now via a package import/workspace dependency and package-level typecheck, or keep implementation in `src/onclave` and document the future extraction in `AGENTS.md`.

## Finding 4
severity: low
evidence: The plan adds a `justfile` as a “standard command surface” and requires recipes including Pi-local wrappers, but current `package.json` already exposes `test` and `typecheck`. This adds another tool dependency for a packaging refactor.
required_fix: Treat `justfile` as optional convenience, not MVP. Minimum required validation should remain npm/pnpm scripts that work after `npm install` because Pi git install uses npm by default.

## Finding 5
severity: medium
evidence: Root must remain npm-compatible for `pi install git:...`, but validation centers on `pnpm install`, `pnpm test`, and `just check`. No acceptance criterion tests `npm install`/`npm test` or confirms workspace metadata does not break Pi’s npm-based install path.
required_fix: Add an npm-path smoke gate: clean install with npm or equivalent isolated install check, then verify root Pi metadata loads without relying on pnpm workspace behavior or just recipes.
