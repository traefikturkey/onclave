# Onclave Repository Guidance

This repo is organized as a monolithic Onclave repository. For the current
stage, the implemented communication subsystem lives under a single extension
subtree instead of being split across multiple top-level packages.

## Current structure

- `extensions/onclave-comms/` contains the Pi extension package metadata,
  runtime entrypoint, reusable TypeScript communication logic, colocated tests,
  and helper scripts.
- `extensions/onclave-comms/src/onclave-comms.ts` is the extension entry
  registered by package `pi` metadata.
- `extensions/onclave-comms/src/lib/` contains Onclave communication source for
  identity, transport, discovery, hub runtime, trust, and status behavior.
- `extensions/onclave-comms/tests/` validates the current behavior through Vitest
  tests.
- `extensions/onclave-comms/scripts/` contains repo-local acceptance helpers for
  the communication subsystem.
- `justfile` is the standard command surface for setup, typecheck, test, and
  local Pi loading.

## Development commands

Happy developer path:

```bash
just setup
just check
just pi-local
```

- Use `pnpm` for development dependency management.
- Run `just setup` to install dependencies.
- Run `just check` before handing off changes; it runs typecheck and Vitest tests.
- Run `just typecheck` or `just test` when you need a narrower check.
- Run `just pi-local` to start Pi with `./extensions/onclave-comms` loaded.
- Package scripts (`pnpm typecheck`, `pnpm test`) must remain runnable without
  `just` so root npm/Pi git installs stay compatible.

## Pi package boundaries

- Root `package.json` exposes Onclave through `pi.extensions` for
  `pi install git:...` and local root installs.
- `extensions/onclave-comms/package.json` exposes
  `./src/onclave-comms.ts` for repo-local package loading.
- Loading `extensions/onclave-comms` directly is supported inside this repo
  checkout and contains its current implementation under the same subtree.
- Keep vocabulary standardized on `Onclave` for the product and
  `onclave-comms` for the communication extension.

## Future locations

- Put protocol schemas and shared wire-format fixtures under `packages/protocol`
  when they become real code.
- Put durable services such as observer, guardrail, gateway, or workspace
  provisioning components under `services/` when implemented.
- Put mobile client code under `mobile/` when implemented.
- Do not create empty future packages just to reserve names.
