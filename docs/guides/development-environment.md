---
created: 2026-05-27
status: active
---

# Development Environment and Monorepo Package Requirements

This guide defines the repository-wide environment, package, and dependency
requirements for `onclave` as it grows into a larger monorepo.

Use this guide as the default standard for new packages, extensions, scripts,
and shared tooling added to the repository.

## Goals

- keep workspace setup predictable for humans and agents;
- standardize package management before the monorepo grows;
- keep root-level tooling authoritative for shared development workflows; and
- make environment validation easy with shell-native bootstrap preflight commands.

## Repository Tooling Requirements

The current repository command surface assumes these tools are available on the
local machine.

### Required for normal development

- `node` on `PATH`
- `pnpm` on `PATH`
- `just` on `PATH`
- `git` on `PATH`

### Required for Pi extension loading and local smoke checks

- `pi` on `PATH`

### Current version policy

- The root workspace pins `pnpm` with `packageManager` in `package.json`.
- The repository is currently validated most directly with Node.js `24.x`.
- If your local Node.js major version differs, treat that as a compatibility
  warning and verify carefully before changing shared tooling.

Current root metadata:

- `package.json`
- `pnpm-workspace.yaml`
- `justfile`

## Standard Commands

Use these commands from the repository root.

Bootstrap preflight:

```powershell
pwsh -File ./scripts/preflight.ps1
```

```bash
bash ./scripts/preflight.sh
```

Normal repo workflow after bootstrap passes:

```bash
just setup
just check
just pi-local
```

Optional repo-aware Node check after bootstrap passes:

```bash
just preflight-repo
pnpm run preflight:repo
```

## Preflight

Run the bootstrap preflight before installing dependencies or starting work in a
fresh environment.

PowerShell:

```powershell
pwsh -File ./scripts/preflight.ps1
```

Bash / Git Bash / WSL / Linux / macOS:

```bash
bash ./scripts/preflight.sh
```

The bootstrap preflight checks:

- Node.js availability and reports the current version
- `pnpm` availability and whether it matches the workspace major version
- `just` availability
- `git` availability
- `pi` availability for local extension loading
- whether `node_modules` appears to be present
- whether `pnpm-workspace.yaml` exists

After bootstrap passes, an optional repo-aware Node check is also available:

```bash
just preflight-repo
pnpm run preflight:repo
```

Machine-readable output is available from the repo-aware Node check:

```bash
node ./scripts/preflight.mjs --json
```

## Workspace Package Management Policy

These rules apply to the whole repository.

### Package manager

- `pnpm` is the required package manager for this workspace.
- Do not use `npm install`, `yarn install`, or `bun install` for workspace
  dependency management.
- The root `package.json` is the source of truth for the workspace
  `packageManager` value.

### Workspace layout

- `pnpm-workspace.yaml` is the source of truth for workspace package locations.
- New workspace packages must be added through the workspace manifest rather
  than managed as isolated ad hoc folders.
- The repository root owns the shared install lifecycle.

Current workspace scope:

```yaml
packages:
  - "extensions/*"
```

### Root package responsibilities

The root `package.json` should own:

- the workspace `packageManager` value;
- shared development scripts such as `preflight:repo`, `setup`, `check`,
  `test`, and `typecheck`;
- shared development dependencies used across multiple packages; and
- monorepo-wide metadata used by agents and CI.

The root `justfile` should mirror the common repo workflow with targets such as
`preflight-repo`, `setup`, `check`, and `pi-local`.

### Workspace package responsibilities

Each package under the workspace should own:

- its package name and package-local metadata;
- runtime dependencies required only by that package; and
- package-specific scripts only when the root command surface is not enough.

A workspace package should not redefine repository-wide install policy.

## Dependency Placement Rules

Use these defaults when adding dependencies.

### Put dependencies in the root package when

- they support the whole repo;
- they are used by multiple workspace packages;
- they are part of the shared test, typecheck, lint, or release workflow; or
- agents and CI are expected to run them from the repository root.

Examples:

- `typescript`
- `vitest`
- shared CLI helpers used across packages

### Put dependencies in a workspace package when

- they are only needed by one package at runtime;
- they define that package's public behavior; or
- they are intentionally package-scoped for future extraction.

Examples:

- package-specific runtime SDKs
- feature-local adapters
- package-local optional integrations

## Script Standardization Rules

As the monorepo grows:

- prefer root-level `just` targets for common workflows;
- mirror important root workflows in `package.json` scripts where practical;
- keep package-specific scripts local when they only make sense inside one
  workspace package; and
- keep names predictable across command surfaces:
    - shell bootstrap: `preflight`
    - `just`: `preflight-repo`, `setup`, `typecheck`, `test`, `check`
    - `package.json`: `preflight:repo`, `setup`, `typecheck`, `test`, `check`

## Requirements for New Packages

When adding a new workspace package, provide at minimum:

- a `package.json` with a unique package name;
- inclusion through `pnpm-workspace.yaml`;
- clear ownership of package-local runtime dependencies;
- compatibility with root install and check flows; and
- documentation describing how the package participates in the monorepo.

If a package needs custom setup beyond the root workflow, document the reason in
that package README.

## Onclave-Specific Runtime Requirements

For `extensions/onclave-pi`, additional runtime prerequisites apply when you
run local Pi sessions or multi-host acceptance:

- `pi` must be installed locally;
- firewalls must allow `48889/udp` for LAN discovery when discovery is used;
- firewalls must allow inbound TCP for the selected WSS hub port; and
- operators must exchange only public `ssh-ed25519` trust lines.

See these documents for the Onclave runtime flow:

- `docs/extensions/onclave-pi/README.md`
- `docs/extensions/onclave-pi/operator-guide.md`
- `docs/extensions/onclave-pi/manual-acceptance.md`

## Recommended Fresh-Machine Flow

```bash
bash ./scripts/preflight.sh
just setup
just check
just pi-local
```

If bootstrap preflight fails, fix the reported tool or version issue first
rather than debugging downstream command failures.
