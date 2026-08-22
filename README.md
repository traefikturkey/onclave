# Onclave

Onclave provides a containerized coordination service and adapters for trusted
agent communication. The supported Pi integration is `extensions/onclave-pi`.

## Architecture

- `packages/envelope` defines shared envelopes, performatives, budgets,
  provenance, and signed delegation grants.
- `services/core` provides registry, presence, adapter RPC, durable delivery,
  conversation budgets, audit, and vault services.
- `extensions/onclave-pi` connects Pi to the Onclave API over signed HTTPS.
- `deploy` and `infra` contain provider-neutral deployment assets.

The former in-session LAN hub has been retired. Onclave now uses the
independent core service as its only communication path.

## Prerequisites

Run the bootstrap preflight for your shell before installing dependencies.

### PowerShell

```powershell
pwsh -File ./scripts/preflight.ps1
```

### Bash, Git Bash, WSL, Linux, or macOS

```bash
bash ./scripts/preflight.sh
```

The scripts check for Node.js, pnpm, just, Git, and the optional local Pi
installation. Repository-wide requirements are documented in
[Development Environment](./docs/guides/development-environment.md).

## Development

```bash
just setup
just check
just test-integration
```

- `just setup` installs the pnpm workspace.
- `just check` runs TypeScript typechecking and unit tests.
- `just test-integration` runs the broker-backed integration suite.
- `just core-dev` starts the core service in watch mode.

## Pi adapter

Load the supported adapter from this checkout:

```bash
just pi-local
```

Equivalent command:

```bash
pi -e ./extensions/onclave-pi
```

The dotfiles integration loads the same adapter through
`pi/extensions/onclave-pi.ts`. The adapter obtains `ONCLAVE_API_BASE` from the
configured secret source and signs API requests with the local SSH identity.

Package metadata also supports local or Git installation:

```bash
pi install .
pi install git:git@github.com:traefikturkey/onclave.git
```

## Documentation

- [Pi adapter PRD](./docs/extensions/onclave-pi/PRD.md)
- [Pi adapter implementation plan](./docs/extensions/onclave-pi/implementation-plan.md)
- [Pi adapter status](./docs/extensions/onclave-pi/status.md)
- [Development environment](./docs/guides/development-environment.md)
