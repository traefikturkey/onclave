---
status: active
---

# Onclave Pi Usage Guide

`onclave-pi` is the Pi runtime extension for the public Onclave HTTPS/WebSocket
gateway. It uses the gateway API and authenticated WSS session; it does not
provide a separate Pi-to-Pi LAN hub or direct RabbitMQ interface.

For the public wire contract, see [the agent gateway contract](../../agent-gateway.md).
For operational setup and troubleshooting, see [the operator guide](./operator-guide.md).

## Configuration

Set these values before starting Pi:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

The agent must already be enrolled and approved by the gateway operator. The
matching Ed25519 private key is loaded from the product-level Pi state root:

```text
~/.pi/onclave/
```

Do not put private keys, session tokens, or broker credentials in source control
or logs.

## Load the extension

From the repository root:

```bash
just setup
pi -e ./extensions/onclave-pi
```

The repository shortcut is:

```bash
just pi-local
```

The extension authenticates during `session_start`, negotiates its required
capabilities, and closes the authenticated session during `session_shutdown`.

## Tools

### `onclave_send`

Submit a task prompt to an enrolled target agent.

```text
onclave_send target_agent_id="agent-executor" prompt="Run the test suite"
```

The tool returns the accepted task ID.

### `onclave_get`

Retrieve the current task state.

```text
onclave_get task_id="task_..."
```

### `onclave_await`

Wait for a task to reach a terminal state.

```text
onclave_await task_id="task_..." timeout_ms=30000
```

The extension caps the wait duration to protect the Pi session from unbounded
blocking.

## Inbound tasks

The authenticated WSS session can deliver commands targeting the configured Pi
agent. The extension injects an inbound task into Pi, then reports the result
from the corresponding `agent_end` lifecycle event.

A disconnected Pi session does not erase gateway task state. Reconnect Pi and
use the task ID with `onclave_get` or `onclave_await`.

## Security behavior

- Gateway URLs must use HTTPS; WSS is derived for the session.
- The extension requests only `message.send` and `message.receive`.
- Enrollment and approval remain gateway/operator responsibilities.
- Private keys and bearer tokens are not written to audit output.
- Gateway status and error context are retained without logging credentials.
- Pi shutdown closes the gateway session and clears in-memory delivery state.

## Local checks

Run the focused registration test:

```bash
pnpm exec vitest run extensions/onclave-pi/tests/extension.test.ts
```

Run the complete TypeScript suite:

```bash
pnpm run typecheck
pnpm run test
```

Run the gateway boundary acceptance flow with the Compose stack running:

```bash
just gateway-acceptance
just gateway-restart-acceptance
just gateway-broker-restart-acceptance
```

For broker-level integration coverage:

```bash
just go-rabbitmq-test
```

These acceptance flows use the public gateway boundary. Runtime integrations do
not connect directly to RabbitMQ.
