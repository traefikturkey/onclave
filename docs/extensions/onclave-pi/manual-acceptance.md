---
status: active
---

# Onclave Pi Gateway Acceptance

This runbook validates the `onclave-pi` runtime extension against the public
Onclave HTTPS/WebSocket gateway. It does not require Pi-to-Pi LAN discovery,
direct RabbitMQ access, or access to gateway SQLite files.

## Prerequisites

- Repository dependencies installed with `just setup`.
- Docker available if using the local Compose gateway.
- A running Onclave gateway and RabbitMQ-backed readiness.
- An enrolled and approved Pi agent with an Ed25519 private key.
- `ONCLAVE_GATEWAY_URL` and `ONCLAVE_AGENT_ID` configured for Pi.

## Automated checks

Run the repository checks first:

```bash
just check
go test ./services/onclave/...
```

Run the gateway public-boundary acceptance flow with the Compose stack running:

```bash
just gateway-acceptance
```

Run restart recovery acceptance:

```bash
just gateway-restart-acceptance
```

Run broker restart recovery acceptance:

```bash
just gateway-broker-restart-acceptance
```

Run the live RabbitMQ Go integration suite when broker-level verification is
required:

```bash
just go-rabbitmq-test
```

## Pi smoke flow

From the repository root:

```bash
pi -e ./extensions/onclave-pi
```

Verify:

1. Pi starts without a module-import network call failure.
2. The extension establishes an authenticated gateway session.
3. The Pi runtime exposes:

   ```text
   onclave_status
   onclave_send
   onclave_task
   onclave_cancel
   onclave_await
   ```

4. `onclave_status` reports local readiness without a network request.
5. `onclave_send` accepts a task using `instruction` for an enrolled target.
6. `onclave_task` returns the submitted task state.
7. `onclave_cancel` requests cancellation and returns the resulting state.
8. `onclave_await` returns after the task reaches a terminal state.
9. Pi shutdown closes the authenticated session.

## Negative checks

Verify that:

- an HTTP gateway URL is rejected;
- missing `ONCLAVE_GATEWAY_URL` or `ONCLAVE_AGENT_ID` produces a clear error;
- an unapproved or mismatched private key cannot authenticate;
- unsupported capabilities are not requested;
- gateway errors do not print private keys or session tokens;
- Pi does not connect directly to RabbitMQ or read gateway SQLite files.

## Evidence to record

Record only non-sensitive evidence:

- command used;
- gateway URL hostname, without credentials;
- agent IDs, if acceptable for the environment;
- task IDs;
- HTTP status or gateway error code;
- final task state;
- test command results.

Never record private keys, bearer tokens, broker passwords, or sensitive task
payloads.
