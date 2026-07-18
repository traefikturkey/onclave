# Onclave

`Onclave` is a Pi extension for secure LAN discovery, explicit trust, and
prompt routing between Pi sessions on trusted machines.

> [!NOTE]
> This project expands on IndyDevDan's Pi coding agent extension work for
> two-way communication between agents and takes it further into secure LAN
> discovery, explicit machine trust, and authenticated cross-host messaging.
> Watch his video here:
> [Pi coding agent extension with two-way agent communication](https://www.youtube.com/watch?v=PIdETjcXNIk)

## What It Does

- starts or reuses one local machine hub per host;
- discovers peer hubs on the LAN over UDP broadcast;
- requires explicit Ed25519 trust exchange before remote access is allowed;
- routes prompts and responses over authenticated WSS connections;
- supports static peers when UDP discovery is unavailable;
- shows peer status directly in Pi with a compact widget.

## v2 Broker Architecture

Onclave v2 (branch `feature/v2-broker-core`) restructures the system around
an independent containerized core service with RabbitMQ as the delivery
substrate, replacing the in-session hub model:

- `packages/envelope` - shared envelope schema: required performatives
  (`request | inform | query | failure | not_understood`), strict
  validation, AMQP property mapping, budgets, provenance framing;
- `services/core` - the onclave-core service: registry and presence,
  versioned adapter RPC, per-agent durable queues with dead-lettering,
  conversation budgets with forced termination, JSONL audit;
- `extensions/onclave-pi` - the thin Pi adapter: durable consume with
  validate-on-read, structurally inert `inform` delivery, strict reply
  correlation by message id, cross-host confirmation with restart-free
  auto-accept policy.

v1 (`extensions/onclave-comms`) stays frozen and passing until the v2
adapter reaches parity.

### v2 Quick Start

```bash
just setup
just up                                        # rabbitmq + onclave-core containers
just check                                     # typecheck + unit tests
just test-integration                          # broker-backed integration suite
pnpm exec tsx scripts/onclave-v2-acceptance.ts # end-to-end acceptance
just pi-local-v2                               # Pi session with the v2 adapter
```

Broker credentials for local development default to the values in
`docker/.env.example`; copy it to `docker/.env` (gitignored) to override.
See [v2 PRD](./docs/extensions/onclave-comms/v2-PRD.md),
[v2 implementation plan](./docs/extensions/onclave-comms/v2-implementation-plan.md),
[v2 status](./docs/extensions/onclave-comms/v2-status.md), and the
[v2 manual acceptance runbook](./docs/extensions/onclave-comms/v2-manual-acceptance.md).

## Development Prerequisites

Before installing dependencies in a fresh environment, run the bootstrap
preflight that matches your shell:

### PowerShell

```powershell
pwsh -File ./scripts/preflight.ps1
```

### Bash / Git Bash / WSL / Linux / macOS

```bash
bash ./scripts/preflight.sh
```

These bootstrap scripts check for the required repo tools (`node`, `pnpm`,
`just`, `git`) and report whether `pi` is available for local extension
loading.

Once bootstrap passes, you can also run the repo-aware Node check:

```bash
just preflight-repo
```

Repository-wide environment and package standards live in:

- [Development Environment and Monorepo Package Requirements](./docs/guides/development-environment.md)

## Quick Start

From this repository, the happy developer path is:

```bash
bash ./scripts/preflight.sh
just setup
just check
just pi-local
```

- `bash ./scripts/preflight.sh` checks bootstrap tool and workspace readiness.
- `just setup` installs dependencies with pnpm.
- `just check` runs typecheck and tests.
- `just pi-local` starts Pi with `./extensions/onclave-comms` loaded.

For a named local session, run Pi directly:

```bash
pi -e ./extensions/onclave-comms --name host-a
```

## Install the Pi Extension

Use one of these install/load paths depending on what you are trying to do.

### Local development load

Use this while working in this repo:

```bash
bash ./scripts/preflight.sh
just setup
just pi-local
```

Equivalent direct Pi command:

```bash
pi -e ./extensions/onclave-comms
```

### Local package install

Use this to test package metadata from a local checkout:

```bash
pi install .
```

### Git package install

Use this to install from a Git remote:

```bash
pi install git:git@github.com:traefikturkey/onclave.git
```

After installing from a local path or Git URL, start Pi normally and run:

```text
onclave_status
```

Loading `extensions/onclave-comms` directly is supported when the directory
remains inside this repo checkout.

Then inside Pi:

```text
onclave_status
onclave_agents
onclave_peers
```

If you want help preparing a host for manual acceptance testing:

```bash
pnpm run onclave:acceptance-host -- --host-name host-a
```

## Documentation

- [Development Environment](./docs/guides/development-environment.md) - repository-wide tool,
  package, dependency, and preflight standards for the monorepo
- [Usage Guide](./docs/extensions/onclave-comms/README.md) - quick starts, extension loading, flags,
  status dots, and tool examples
- [Operator Guide](./docs/extensions/onclave-comms/operator-guide.md) - runtime state,
  trust exchange, discovery, messaging, and troubleshooting
- [Manual Acceptance](./docs/extensions/onclave-comms/manual-acceptance.md) - step-by-step
  host-to-host validation flow
- [Status](./docs/extensions/onclave-comms/status.md) - implementation progress and delivered scope
- [Design Decisions](./docs/extensions/onclave-comms/decisions.md) - key v1 design choices
- [onclave-comms Requirements](./docs/extensions/onclave-comms/onclave-comms-PRD.md) - original communication extension requirements and success
  criteria

## Current Usage Model

1. Start Pi with `extensions/onclave-comms` loaded from inside this repo checkout.
2. Run `onclave_status` to initialize or reuse the local hub.
3. Exchange `ssh-ed25519` public key lines with trusted peers.
4. Use `onclave_peers` and `onclave_remote_agents` to find reachable remote
   sessions.
5. Use `onclave_send` or `onclave_remote_send` to route prompts.

For the full tool reference and examples, start with
[docs/extensions/onclave-comms/README.md](./docs/extensions/onclave-comms/README.md).
