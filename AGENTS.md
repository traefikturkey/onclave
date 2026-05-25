# Onclave Repository Guidance

This repo is organized as a Pi-installable Onclave plugin package while
keeping reusable implementation code separated from Pi integration code.

## Current structure

- `extensions/pi-onclave/` contains the Pi extension package metadata and
  runtime entrypoint.
- `extensions/pi-onclave/src/onclave.ts` is the extension entry registered by
  package `pi` metadata.
- `packages/core/` contains reusable TypeScript source for Onclave identity,
  transport, discovery, hub runtime, trust, and status behavior.
- `tests/onclave/` validates the current behavior through Bun tests.
- `scripts/` contains repo-local developer and acceptance helpers.
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
- Run `just check` before handing off changes; it runs typecheck and tests.
- Run `just typecheck` or `just test` when you need a narrower check.
- Run `just pi-local` to start Pi with `./extensions/pi-onclave` loaded.
- Package scripts (`pnpm typecheck`, `pnpm test`) must remain runnable without
  `just` so root npm/Pi git installs stay compatible.

## Pi package boundaries

- Root `package.json` exposes Onclave through `pi.extensions` for
  `pi install git:...` and local root installs.
- `extensions/pi-onclave/package.json` exposes `./src/onclave.ts` for repo-local
  package loading.
- Loading `extensions/pi-onclave` directly is supported only inside this repo
  checkout because it imports `packages/core` by relative source path; it is not
  a standalone copied package yet.
- Keep vocabulary standardized on `onclave`.

## Future locations

- Put protocol schemas and shared wire-format fixtures under `packages/protocol`
  when they become real code.
- Put durable services such as observer, guardrail, gateway, or workspace
  provisioning components under `services/` when implemented.
- Put mobile client code under `mobile/` when implemented.
- Do not create empty future packages just to reserve names.
