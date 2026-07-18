---
status: active
---

# Onclave Pi Extension Guide

`onclave-pi` is the first-party Pi extension for the public Onclave HTTPS and
WebSocket gateway. It does not connect directly to RabbitMQ or gateway SQLite.

## Installation

From a repository checkout:

```bash
just setup
pi -e ./extensions/onclave-pi
```

For Pi's Git package loader, install the repository root package:

```bash
pi install git:https://github.com/traefikturkey/onclave.git
```

Use `just pi-local` as the repository shortcut for local loading.

## Configuration

Set:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

Store the matching Ed25519 private key at `~/.pi/onclave/identity.key`. The
agent must already be enrolled and approved. The extension performs
challenge-response authentication during `session_start` and negotiates only
`message.send` and `message.receive`.

## Commands

Check local readiness without a network request:

```text
onclave_status
```

Submit asynchronous work with the canonical `instruction` parameter:

```text
onclave_send target_agent_id="agent-executor" instruction="Run the test suite"
```

Optional submission parameters are `task_id`, `correlation_id`, and
`expires_at`.

Read task state:

```text
onclave_task task_id="task_..."
```

Request cancellation:

```text
onclave_cancel task_id="task_..." reason="No longer needed"
```

Wait for a bounded period:

```text
onclave_await task_id="task_..." timeout_ms=30000
```

Task results use normalized fields including `task_id`, `state`, `progress`,
`note`, `result`, `created_at`, and `updated_at` when supplied by the gateway.

## Inbound tasks

The authenticated WSS session delivers commands targeting the configured Pi
agent. Commands are injected into Pi and acknowledged only after host
acceptance. Duplicate deliveries are ignored by message and task identity.
The extension reports `task.ack`, `task.started`, and the applicable terminal
lifecycle event.

## Security and lifecycle

- Gateway URLs must use HTTPS; the session uses derived WSS.
- Private keys and bearer tokens are never included in status or diagnostics.
- Gateway errors retain HTTP status and optional gateway code context.
- Session expiry and WebSocket closure trigger authenticated reconnect.
- Shutdown closes the session and all extension timers.

See the [operator guide](./operator-guide.md), [acceptance runbook](./manual-acceptance.md),
[agent gateway contract](../../agent-gateway.md), and
[agent extension contract](../../agent-extension-contract.md).

## Verification

```bash
pnpm run check
pnpm exec vitest run extensions/onclave-pi/tests
```
