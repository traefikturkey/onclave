---
status: active
---

# Onclave Pi Operator Guide

`onclave-pi` is a Pi runtime extension for the public Onclave HTTPS/WebSocket
gateway. RabbitMQ, SQLite, enrollment approval, and gateway persistence belong
to the gateway deployment, not to the Pi host.

Use [the Pi extension guide](./README.md) for the tool contract. Use
[the gateway contract](../../agent-gateway.md) for the authoritative API,
authentication, capabilities, subscriptions, lifecycle, replay, TLS, and
operational endpoint documentation.

## Prerequisites

The Pi host needs:

- Pi installed and available as `pi`;
- network access to the configured HTTPS gateway;
- an enrolled and approved Onclave agent ID;
- the matching Ed25519 private key in the Pi Onclave state directory.

The product-level state root is:

```text
~/.pi/onclave/
```

Do not place private keys in source control or print them in diagnostics.

## Configuration

Set:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-pi
```

The gateway URL must use HTTPS. The extension derives the authenticated WSS
session endpoint from that gateway URL.

## Enrollment and approval

Enrollment and approval are operator/deployment operations:

1. Enroll the agent with `POST /v1/enroll`.
2. Approve the enrolled agent with `POST /v1/agents/{agentID}/approve`.
3. Store the matching private key only in the Pi host's protected Onclave state.
4. Start Pi with `extensions/onclave-pi` loaded.

The extension performs challenge-response authentication during `session_start`
and negotiates its required capabilities.

## Start Pi

From the repository root:

```bash
just setup
pi -e ./extensions/onclave-pi
```

Or use the repository command:

```bash
just pi-local
```

A successful session exposes the `onclave` status indicator and registers:

```text
onclave_send
onclave_get
onclave_await
```

## Task workflow

1. Use `onclave_send` with an enrolled target agent ID and prompt.
2. Record the returned task ID.
3. Use `onclave_get` for an immediate task-state read.
4. Use `onclave_await` when waiting for a terminal state.
5. The target runtime reports lifecycle events through the gateway.

The gateway task record remains durable across Pi disconnects. Reconnecting Pi
does not require direct broker access or local gateway database access.

## Troubleshooting

### Authentication fails

- Confirm `ONCLAVE_GATEWAY_URL` is the correct HTTPS endpoint.
- Confirm the agent ID is enrolled and approved.
- Confirm the private key matches the enrolled public key.
- Confirm the gateway is ready at `/readyz`.
- Check gateway logs without printing the private key or session token.

### Capability negotiation fails

The Pi extension requests:

```text
message.send
message.receive
```

Confirm both capabilities are allowed by the gateway's
`ONCLAVE_ALLOWED_CAPABILITIES` policy and that the authenticated agent is
permitted to request them.

### Task submission fails

- Confirm the target agent ID is enrolled and approved.
- Confirm the source agent has `message.send`.
- Confirm the target agent has the capabilities required by the task.
- Inspect the gateway HTTP status and error code.
- Use `onclave_get` only with the returned task ID.

### Inbound tasks are not delivered

- Confirm the Pi WSS session reached `session.ready`.
- Confirm the source task targets the configured Pi agent ID.
- Confirm the Pi process remains running.
- Check gateway readiness and session logs.
- Restart Pi to establish a fresh authenticated session.

### Pi shuts down or reconnects

The extension closes its WSS session during shutdown. Gateway task state is
durable, so reconnect Pi and retry task lookup with the existing task ID.

## Acceptance validation

The gateway boundary can be validated without exposing RabbitMQ:

```bash
just gateway-acceptance
just gateway-restart-acceptance
just gateway-broker-restart-acceptance
```

These flows use only the gateway HTTP/WebSocket API. See
[the gateway contract](../../agent-gateway.md#live-rabbitmq-verification) for
the complete acceptance options.
