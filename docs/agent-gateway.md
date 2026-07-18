# Onclave agent gateway contract

The public agent integration surface is the Onclave HTTPS API plus authenticated WebSocket sessions. Agent runtimes do not connect to RabbitMQ directly.

## Configuration

Adapters need:

- `ONCLAVE_GATEWAY_URL`: gateway base URL, for example `https://onclave.example`.
- an enrolled agent ID;
- an approved agent credential/private key;
- a session token obtained through challenge-response authentication.

RabbitMQ credentials remain internal to the gateway deployment.

Gateway deployment settings:

- `ONCLAVE_SESSION_TTL`: Go duration for authenticated session leases; defaults to `24h`.
- `ONCLAVE_TLS_CERT_FILE` and `ONCLAVE_TLS_KEY_FILE`: configure both to enable native HTTPS. Mount certificate material read-only; configuring only one is rejected at startup.
- `ONCLAVE_ALLOWED_CAPABILITIES`: comma-separated capabilities available to all runtime types; Compose defaults to `message.send,message.receive`. Agents still receive only the intersection of declared and allowed capabilities.
- If native TLS is not configured, terminate HTTPS at the deployment's reverse proxy and keep the gateway bound to a private network or loopback address.

## Authentication

1. Enroll the runtime with `POST /v1/enroll`.
2. An operator approves the agent with `POST /v1/agents/{agentID}/approve`.
3. An operator revokes an enrolled agent with `POST /v1/agents/{agentID}/revoke`; existing sessions are rejected thereafter.
4. Request a challenge with `POST /v1/agents/{agentID}/challenge`.
5. Sign the returned nonce with the enrolled private key.
6. Authenticate with `POST /v1/agents/{agentID}/authenticate`.
7. Use the returned token as `Authorization: Bearer <token>`.

Tokens are bound to the authenticated agent and are required for capability, command, task, and WebSocket operations.

## Commands

Submit work asynchronously:

```http
POST /v1/commands
Authorization: Bearer <token>
Content-Type: application/json

{
  "messageId": "message-1",
  "taskId": "task-1",
  "correlationId": "workflow-1",
  "sourceAgentId": "planner",
  "targetAgentId": "executor",
  "type": "task.assign",
  "expiresAt": "2026-07-17T12:05:00Z",
  "payload": {"instruction": "run tests"}
}
```

The gateway returns `202 Accepted` with task metadata. The request does not remain open while work executes.

## WebSocket session

Connect to:

```text
wss://gateway.example/v1/agents/{agentID}/session
```

The default event subscription is `task.*.{agentID}`. A session may request
one narrower lifecycle pattern using the `events` query parameter, for example
`?events=task.completed.agent-id`; the gateway only accepts patterns scoped to
the authenticated agent.

Durable observers use the subscription API with the agent's bearer session:

- `POST /v1/subscriptions` creates a lease-backed subscription. The body accepts
  `pattern`, optional `correlationId`, optional `taskId`, and `expiresAt`.
- `GET /v1/subscriptions/{subscriptionId}` reads the subscription.
- `POST /v1/subscriptions/{subscriptionId}/renew` renews its lease.
- `POST /v1/subscriptions/{subscriptionId}/cursor` advances its replay cursor;
  cursors are monotonic.
- `DELETE /v1/subscriptions/{subscriptionId}` removes it.

Connect a WebSocket with `subscriptionId` to replay retained task events after
the stored cursor and continue receiving live events. Subscription ownership
and `message.receive` capability are enforced for every operation. Optional
`correlationId` and `taskId` query parameters further filter events without
widening the agent scope.

For RabbitMQ TLS deployments, set `ONCLAVE_RABBITMQ_URL` to an `amqps://` URL
and set `ONCLAVE_RABBITMQ_CA_FILE` to a mounted PEM CA bundle. The gateway
requires TLS 1.2 or newer, validates the broker hostname, and reuses the CA
bundle after reconnect. The local Compose profile intentionally uses private
plain AMQP on the internal Docker network; do not publish RabbitMQ ports in a
production deployment.

An opt-in broker-side TLS override is provided at
`infrastructure/docker/onclave-compose.tls.yml`. Place deployment-specific
`ca.pem`, `server.pem`, and `server-key.pem` under
`infrastructure/docker/rabbitmq/certs/` (never commit private keys), then start
with both Compose files and `ONCLAVE_RABBITMQ_PASSWORD` set. The override moves
RabbitMQ to port 5671, disables plain AMQP, and mounts the CA into Onclave.

Send the bearer token in the WebSocket handshake `Authorization` header. The first server message is:

```json
{"type":"session.ready","agentId":"executor"}
```

Heartbeat:

```json
{"type":"heartbeat"}
{"type":"heartbeat.ack"}
```

Command delivery:

```json
{
  "type": "command.delivery",
  "messageId": "message-1",
  "taskId": "task-1",
  "correlationId": "workflow-1",
  "sourceAgentId": "planner",
  "targetAgentId": "executor",
  "messageType": "task.assign",
  "payload": {"instruction": "run tests"}
}
```

Target agents also receive lifecycle fan-out messages for their own tasks:

```json
{
  "type": "task.event",
  "messageId": "message-1:task.completed:2026-07-17T12:00:00Z",
  "taskId": "task-1",
  "messageType": "task.completed",
  "payload": {"eventType": "task.completed", "state": "completed"}
}
```

## Task lifecycle

The target agent may send:

```json
{"type":"task.ack","taskId":"task-1"}
{"type":"task.started","taskId":"task-1"}
{"type":"task.progress","taskId":"task-1","progress":50,"note":"tests running"}
{"type":"task.completed","taskId":"task-1","result":{"passed":true}}
```

The source or target agent may cancel according to policy:

```json
{"type":"task.cancelled","taskId":"task-1"}
```

Lifecycle operations are ownership-checked by the gateway. A disconnected session does not erase durable task state; the agent may reconnect and resume.

Task event replay supports bounded reads:

- `GET /v1/tasks/{taskID}/events?limit=100` returns at most 100 events.
- `after` is a zero-based event offset for the next page.
- When more events remain, the response includes `X-Next-After`.
- `limit` must be between 1 and 500.

## RabbitMQ implementation boundary

The gateway publishes targeted commands to a durable internal queue for each agent. Adapters must not depend on queue names, exchange names, or AMQP credentials. This keeps the public contract stable if RabbitMQ is replaced or reconfigured.

## Live RabbitMQ verification

The repository includes a private-network integration runner:

```bash
just go-rabbitmq-test
```

It starts the Compose RabbitMQ service and runs the full Go suite from a temporary container sharing RabbitMQ's network namespace. The suite covers queue delivery, publisher recovery after channel closure, and TTL/dead-letter observation.

The gateway acceptance flow can also verify durable state across an Onclave
restart. With the Compose stack running, use:

```bash
ONCLAVE_ACCEPTANCE_RESTART=1 node ./scripts/gateway-acceptance.mjs
```

This submits the command, restarts only the gateway, reconnects the source
session, and then verifies delivery, lifecycle completion, and source event
fan-out after the restart. RabbitMQ remains private; the runner uses only the
gateway API and WebSocket boundary.
