# Onclave

Onclave is a containerized, harness-independent agent gateway. It authenticates
and vets agent runtimes, negotiates capabilities, persists task and event state,
and exposes an HTTPS/WebSocket API for adapters and runtime extensions.
RabbitMQ is an internal broker; agents and adapters never connect to it directly.

The repository contains two first-party runtime integrations:

- `extensions/onclave-pi` — Pi extension for the public Onclave gateway;
- `extensions/onclave-hermes` — Hermes Agent plugin for the public Onclave gateway.

The gateway is the product boundary. Runtime integrations use its public
HTTPS/WebSocket contract and must not depend on RabbitMQ topology, broker
credentials, gateway internals, or gateway SQLite files.

## Current Core Architecture

- Go gateway service under `services/onclave`;
- authenticated enrollment, approval, capability negotiation, and sessions;
- durable SQLite tasks, lifecycle events, subscriptions, cursors, outbox state,
  delivery attempts, and audit records;
- authenticated WebSocket command delivery and task-event replay/resumption;
- RabbitMQ internal command/event transport with publisher confirms, reconnect,
  bounded redelivery, dead-letter handling, and broker restart recovery;
- `/healthz`, `/readyz`, JSON metrics, and Prometheus metrics endpoints;
- plain internal AMQP Compose deployment plus an opt-in AMQPS/TLS profile.

## Runtime Integrations

### Pi

`extensions/onclave-pi` connects Pi to the public gateway over HTTPS/WSS. It:

- authenticates with an enrolled Ed25519 identity;
- requests the `message.send` and `message.receive` capabilities;
- submits task prompts to enrolled target agents;
- retrieves task state;
- waits for terminal task state;
- receives inbound gateway commands and reports task completion through the Pi
  session lifecycle.

It does not expose a separate LAN hub or direct RabbitMQ interface.

### Hermes

`extensions/onclave-hermes` is the Hermes Agent plugin for the same public
HTTPS/WebSocket contract. It supports challenge-response authentication,
durable subscriptions, lifecycle reporting, inbound delivery, and idempotency.

## Development Prerequisites

Before installing dependencies in a fresh environment, run the bootstrap
preflight that matches your shell.

### PowerShell

```powershell
pwsh -File ./scripts/preflight.ps1
```

### Bash / Git Bash / WSL / Linux / macOS

```bash
bash ./scripts/preflight.sh
```

These scripts check the required repository tools (`node`, `pnpm`, `just`, and
`git`) and report whether `pi` is available for local extension loading.

After bootstrap passes, run the repository-aware check:

```bash
just preflight-repo
```

Repository-wide environment and package standards live in
[Development Environment](./docs/guides/development-environment.md).

## Quick Start

From the repository root:

```bash
bash ./scripts/preflight.sh
just setup
just check
just pi-local
```

- `just setup` installs dependencies with pnpm.
- `just check` runs TypeScript typecheck and Vitest tests.
- `just pi-local` starts Pi with `./extensions/onclave-pi` loaded.

## Pi Extension

Configure the Pi extension with:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

The matching Ed25519 private key is stored in Pi's Onclave state directory.
Enrollment and operator approval happen through the gateway deployment.

For local development:

```bash
pi -e ./extensions/onclave-pi
```

The extension registers:

```text
onclave_send
onclave_get
onclave_await
```

Use [the Pi extension guide](./docs/extensions/onclave-pi/README.md) for the
configuration and tool contract.

## Gateway Acceptance

With the Compose stack running, the gateway acceptance flow verifies the public
HTTP/WebSocket boundary:

```bash
just gateway-acceptance
just gateway-restart-acceptance
just gateway-broker-restart-acceptance
```

The live RabbitMQ integration suite is:

```bash
just go-rabbitmq-test
```

See [the gateway contract](./docs/agent-gateway.md) for authentication,
commands, subscriptions, lifecycle, replay, TLS, and operational endpoints.

## Documentation

- [Development Environment](./docs/guides/development-environment.md) — tools,
  workspace, dependency, and preflight standards
- [Agent Gateway Contract](./docs/agent-gateway.md) — public HTTPS/WebSocket API,
  authentication, lifecycle, subscriptions, replay, metrics, and TLS
- [Agent Extension Contract](./docs/agent-extension-contract.md) — extension
  placement, manifest, lifecycle, security, replay, and conformance requirements
- [Pi Extension Guide](./docs/extensions/onclave-pi/README.md) — Pi configuration,
  loading, tools, and gateway behavior
- [Pi Operator Guide](./docs/extensions/onclave-pi/operator-guide.md) — gateway
  setup, enrollment, troubleshooting, and task handling
- [Pi Gateway Acceptance](./docs/extensions/onclave-pi/manual-acceptance.md) —
  non-destructive Pi-to-gateway validation
- [Pi Status](./docs/extensions/onclave-pi/status.md) — implemented Pi scope and
  verification status
- [Hermes Plugin Guide](./extensions/onclave-hermes/README.md) — Hermes setup,
  tools, subscriptions, and tests

- [Onclave Future Product PRD](./docs/onclave-factory-PRD.md) — future factory
  workflows, workspaces, runtime adapters, guardrails, and operator capabilities

The future PRD is intentionally separate from the current contracts above. When
future scope is implemented, document the resulting behavior in the active
contract or guide and remove the completed detail from the PRD.
