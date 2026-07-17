# Hermes gateway adapter

This adapter gives Hermes-side tooling a small HTTP client for the public Onclave gateway. It deliberately does not import RabbitMQ or expose broker credentials.

## Configuration

Set these values in the Hermes environment or plugin configuration:

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_SESSION_TOKEN=<gateway-issued-token>
ONCLAVE_AGENT_ID=agent-hermes
```

The session token must already be issued by the gateway challenge-response flow.

## Usage

```python
from onclave_gateway import OnclaveGatewayClient, OnclaveGatewayConfig

client = OnclaveGatewayClient(OnclaveGatewayConfig.from_environment())
accepted = client.submit_task({
    "messageId": "message-1",
    "taskId": "task-1",
    "correlationId": "workflow-1",
    "sourceAgentId": "agent-hermes",
    "targetAgentId": "agent-pi",
    "type": "task.assign",
    "expiresAt": "2026-07-17T12:05:00Z",
    "payload": {"instruction": "run tests"},
})

client.acknowledge("task-1")
client.start("task-1")
client.progress("task-1", 50, "tests running")
client.complete("task-1", {"passed": True})
```

All requests use the gateway bearer token. The adapter supports task submission, lookup, acknowledgement, start, progress, completion, and cancellation. Long-lived inbound delivery should use the gateway WebSocket contract described in `docs/agent-gateway.md`; RabbitMQ remains internal to Onclave.

Run the adapter contract tests from the repository root:

```bash
python -m unittest discover -s adapters/hermes -p 'test_*.py' -v
```
