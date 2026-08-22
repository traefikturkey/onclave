# Onclave Repository Guidance

This repository contains the Onclave core service, shared protocol contracts,
and the Pi adapter.

## Location and collaboration boundaries

- The canonical checkout is the `modules/onclave/` submodule of the dotfiles
  repository. Keep it attached to and tracking `origin/feature/v2-broker-core`;
  do not switch branches unless the user explicitly requests it.
- The sibling `../homelab-infra/` module owns infrastructure, host placement,
  site inventory, deployment orchestration, and private values.
- This repository owns product code, protocols, services, adapters, and
  provider-neutral deployment contracts.
- The dotfiles parent owns workstation and Pi runtime wiring.
  `pi/extensions/onclave-pi.ts` must remain a thin loader for
  `extensions/onclave-pi/src/onclave-pi.ts`.
- Commit and push Onclave changes from this repository before updating the
  parent repository's submodule pointer.

## Current structure

- `extensions/onclave-pi/` contains the supported Pi adapter and its tests.
- `packages/envelope/` contains the shared versioned message, task, and status-event contracts.
- `services/core/` contains the containerized Onclave API and broker service.
- `deploy/` and `infra/` contain provider-neutral deployment assets.
- `justfile` is the standard command surface.

## Development commands

```bash
just setup
just check
just pi-local
```

- Use pnpm for dependency management.
- `just check` runs TypeScript typechecking and Vitest tests.
- `just test-integration` runs the broker-backed integration suite.
- `just pi-local` starts Pi with `./extensions/onclave-pi` loaded.
- Package scripts must remain runnable without `just`.

## Pi package boundaries

- Root `package.json` exposes only `extensions/onclave-pi/src/onclave-pi.ts`
  through `pi.extensions`.
- `extensions/onclave-pi/package.json` owns adapter package metadata.
- Do not add a second Pi communication adapter or restore the retired
  in-session LAN hub implementation.
