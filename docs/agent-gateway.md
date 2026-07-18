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
- If native TLS is not configured, terminate HTTPS at the deployment's reverse proxy and keep the gateway bound to a private network or loopback address.

## Authentication

1. Enroll the runtime with `POST /v1/enroll`.
2. An operator approves the agent with `POST /v1/agents/{agentID}/approve`.
3. Request a challenge with `POST /v1/agents/{agentID}/challenge`.
4. Sign the returned nonce with the enrolled private key.
5. Authenticate with `POST /v1/agents/{agentID}/authenticate`.
6. Use the returned token as `Authorization: Bearer <token>`.

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

## RabbitMQ implementation boundary

The gateway publishes targeted commands to a durable internal queue for each agent. Adapters must not depend on queue names, exchange names, or AMQP credentials. This keeps the public contract stable if RabbitMQ is replaced or reconfigured.
