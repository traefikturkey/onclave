# onclave-pi Pi Extension

`onclave-pi` connects Pi to the public Onclave HTTPS/WebSocket gateway. It is a
runtime extension, not a broker client or an independent gateway service.

## Boundary

The extension uses only the public gateway contract:

- HTTPS challenge-response authentication;
- capability negotiation;
- asynchronous task submission;
- task lookup and terminal-state waiting;
- authenticated WSS inbound command delivery;
- task lifecycle completion reporting.

It does not connect directly to RabbitMQ, read gateway SQLite state, or depend
on gateway service internals.

## Installation

From a repository checkout:

```bash
just setup
pi -e ./extensions/onclave-pi
```

For installation through Pi's Git package loader, install the repository root
package so its `pi.extensions` metadata loads `extensions/onclave-pi`:

```bash
pi install git:https://github.com/traefikturkey/onclave.git
```

Use the repository-local `pi -e` form when developing or testing a checkout.
The complete configuration and usage guide is
[`docs/extensions/onclave-pi/README.md`](../../docs/extensions/onclave-pi/README.md).

## Configuration

Configure the gateway URL and enrolled agent ID in the Pi environment:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

The matching Ed25519 private key is loaded from Pi's Onclave state directory.
The product-level state root is:

```text
~/.pi/onclave/
```

Enrollment and operator approval are performed through the gateway deployment.
The extension does not expose enrollment credentials or session tokens.

## Local loading

From the repository root:

```bash
just setup
pi -e ./extensions/onclave-pi
```

The extension authenticates during `session_start`, requests only
`message.send` and `message.receive`, and closes the authenticated session on
shutdown.

## Tools

### `onclave_send`

Submit a task prompt to an enrolled target agent.

Parameters:

- `target_agent_id` — enrolled target agent ID;
- `prompt` — task instruction.

The tool returns the accepted task ID.

### `onclave_get`

Retrieve the current task state.

Parameters:

- `task_id` — task ID returned by `onclave_send`.

### `onclave_await`

Wait until a task reaches a terminal state or the timeout expires.

Parameters:

- `task_id` — task ID returned by `onclave_send`;
- optional `timeout_ms`, capped by the extension's maximum wait duration.

## Inbound delivery

Commands delivered through the authenticated gateway session are injected into
Pi as inbound messages. After Pi completes the corresponding agent turn, the
extension reports `task.completed` or the applicable failure lifecycle state to
the gateway.

## Security and lifecycle behavior

- Only the configured HTTPS gateway is used.
- Private keys and bearer tokens are not written to audit output.
- Capability requests are limited to `message.send` and `message.receive`.
- Gateway sessions close during Pi shutdown.
- Gateway task state remains durable if Pi disconnects.
- Gateway errors retain status context without exposing credentials.

## Tests

From the repository root:

```bash
pnpm exec vitest run extensions/onclave-pi/tests/extension.test.ts
pnpm run typecheck
pnpm run test
```

The full TypeScript suite includes the Pi extension and the shared protocol
package. Gateway-level live acceptance is documented in
`docs/agent-gateway.md` and exposed through the root `justfile` targets.
