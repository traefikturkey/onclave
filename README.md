# Onclave

`Onclave` is a containerized, harness-independent agent gateway. It authenticates
and vets agent runtimes, negotiates capabilities, persists task and event state,
and exposes an HTTPS/WebSocket API for adapters and runtimes. RabbitMQ is an
internal broker; agents and adapters do not connect to RabbitMQ directly.

The repository also contains the `onclave-comms` Pi extension for secure LAN
discovery and trusted local/remote Pi communication. That extension is one
client/runtime integration, not the boundary of the Onclave product.

> [!NOTE]
> This project expands on IndyDevDan's Pi coding agent extension work for
> two-way communication between agents and takes it further into secure LAN
> discovery, explicit machine trust, and authenticated cross-host messaging.
> Watch his video here:
> [Pi coding agent extension with two-way agent communication](https://www.youtube.com/watch?v=PIdETjcXNIk)

## Current Core Architecture

- Go gateway service under `services/onclave`;
- authenticated enrollment, approval, capability negotiation, and sessions;
- durable SQLite tasks, lifecycle events, subscriptions, cursors, outbox state,
  delivery attempts, and audit records;
- authenticated WebSocket command delivery and task-event replay/resumption;
- RabbitMQ internal command/event transport with publisher confirms, reconnect,
  bounded redelivery, dead-letter handling, and broker restart recovery;
- `/healthz`, `/readyz`, JSON metrics, and Prometheus metrics endpoints;
- plain internal AMQP Compose deployment plus an opt-in AMQPS/TLS profile;
- adapters consume the gateway contract and must not depend on RabbitMQ topology.

## Pi Extension Capabilities

- starts or reuses one local machine hub per host;
- discovers peer hubs on the LAN over UDP broadcast;
- requires explicit Ed25519 trust exchange before remote access is allowed;
- routes prompts and responses over authenticated WSS connections;
- supports static peers when UDP discovery is unavailable;
- shows peer status directly in Pi with a compact widget.

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
- [Agent Gateway Contract](./docs/agent-gateway.md) - authenticated HTTP/WebSocket
  API, durable subscriptions, replay, metrics, RabbitMQ boundary, and TLS deployment
- [Agent Extension Contract](./docs/agent-extension-contract.md) - extension
  placement, manifest, lifecycle, security, replay, and conformance requirements
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
