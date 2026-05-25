## Finding 1

severity: high
evidence: Plan objective requires loading from repo root and from `extensions/pi-onclave`, but T4 requires `extensions/pi-onclave/src/onclave.ts` to import core via relative paths from `packages/core/src/onclave/*`. If only `extensions/pi-onclave` is installed or loaded, `../../../packages/core` is outside that package and absent.
required_fix: Either narrow the supported install target to repo-root only, or make `extensions/pi-onclave` self-contained by depending on a resolvable package name and validating that package-local install/load works.

## Finding 2

severity: high
evidence: Context says Pi git installs run `npm install` at repo root and root must remain npm-compatible, but all validation uses `pnpm install`, `pnpm typecheck`, `pnpm test`, and `just setup/check`. No acceptance criterion verifies npm can install the final workspace/package metadata.
required_fix: Add an explicit npm install validation for Pi git-install compatibility, ideally in a clean/temp checkout, and forbid `workspace:*` or pnpm-only lifecycle assumptions in root metadata used by Pi.

## Finding 3

severity: medium
evidence: T1 creates `packages/core/package.json` and `extensions/pi-onclave/package.json`, but neither acceptance criteria nor validation require package-level `exports`, `types`, or script consistency. With TS source imports, local tests can pass while package metadata points to missing `dist` files or unusable entrypoints.
required_fix: Specify exact `main`/`exports`/`types` policy for non-published workspace packages, or omit misleading fields. Add JSON checks that package metadata entrypoints exist and match the TS-source runtime strategy.

## Finding 4

severity: medium
evidence: Root `tsconfig.json` currently has no `rootDir` and includes `src/**/*.ts`, `tests/**/*.ts`, `extensions/**/*.ts`, `scripts/**/*.ts`. The plan moves source to `packages/core/src`, but only says “update TypeScript includes” without requiring `packages/**/*.ts` or excluding generated outputs.
required_fix: Make the root tsconfig acceptance explicit: include `packages/**/*.ts` and `extensions/**/*.ts`, keep `noEmit`, and exclude `dist`/`node_modules`. Verify with `tsc --showConfig` or a targeted `pnpm typecheck` after the move.
