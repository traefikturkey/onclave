# onclave-pi Pi Extension

`onclave-pi` connects Pi to the public Onclave HTTPS/WebSocket gateway. It is a
runtime extension, not a broker client or gateway service.

## Installation

Install dependencies from a repository checkout:

```bash
just setup
```

Load the extension locally while developing:

```bash
pi -e ./extensions/onclave-pi
```

Install the repository package through Pi's Git package loader:

```bash
pi install git:https://github.com/traefikturkey/onclave.git
```

## Configuration

Set the gateway URL and enrolled agent ID before starting Pi:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

The matching Ed25519 private key must be stored at:

```text
~/.pi/onclave/identity.key
```

The extension authenticates with challenge-response during `session_start`.
Enrollment and operator approval are gateway operations. Never store private
keys or session tokens in source control or logs.

## Commands

### `onclave_status`

Reports local readiness without a network request:

```text
onclave_status
```

The result includes `configured`, `authenticated`, `connected`, `agent_id`,
`gateway_url`, and negotiated capabilities when available.

### `onclave_send`

Submits asynchronous work. The target must be enrolled and permitted by the
gateway:

```text
onclave_send target_agent_id="agent-executor" instruction="Run the test suite"
```

Optional parameters are `task_id`, `correlation_id`, and `expires_at`.
The result includes `message_id`, `task_id`, and the gateway-accepted state.

### `onclave_task`

Reads the current task state:

```text
onclave_task task_id="task_..."
```

The normalized result may include `state`, `progress`, `note`, `result`,
`created_at`, and `updated_at`.

### `onclave_cancel`

Requests cancellation of an owned task. Cancellation is subject to gateway
policy and does not guarantee that work has already stopped:

```text
onclave_cancel task_id="task_..." reason="No longer needed"
```

The result contains the task state after the cancellation request.

### `onclave_await`

Waits for a task to reach `completed`, `failed`, `cancelled`, or `expired`:

```text
onclave_await task_id="task_..." timeout_ms=30000
```

The timeout is capped by the extension and never leaves the host session
unbounded.

## Inbound tasks

The authenticated WSS session delivers commands targeting the configured Pi
agent. The extension injects each accepted command into Pi, acknowledges it
only after host acceptance, and reports task lifecycle events. Duplicate
`message_id` and `task_id` deliveries are ignored safely.

Pi shutdown closes the WebSocket, heartbeat timer, reconnect timer, and
in-memory delivery state.

## Tests

```bash
pnpm run check
pnpm exec vitest run extensions/onclave-pi/tests
```

The extension uses only the public gateway API and never connects directly to
RabbitMQ or reads gateway SQLite files.
