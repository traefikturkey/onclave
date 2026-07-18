# Onclave Hermes plugin

This plugin connects a Hermes Agent runtime to the public Onclave HTTPS/WebSocket gateway. It is a gateway client, not a broker adapter.

## Boundary

The plugin uses only the Onclave public API:

- HTTPS challenge/authentication
- `POST /v1/commands`
- task lookup and lifecycle endpoints
- durable subscriptions and cursor advancement
- authenticated WSS agent sessions

It does not import Onclave services, read gateway SQLite files, or connect to RabbitMQ.

## Install

Copy or install this directory as a Hermes plugin under the active profile's plugin directory:

```text
<HERMES_HOME>/plugins/onclave-hermes/
```

The directory must contain `plugin.yaml`, `__init__.py`, `schemas.py`, `tools.py`, and the `src/` package. Install Python dependencies from this directory when the Hermes environment does not already provide them:

```bash
python -m pip install -r requirements.txt
```

Enable and inspect the plugin with the Hermes CLI:

```bash
hermes plugins enable onclave-hermes
hermes plugins list
```

## Configuration

Configure these values in the active Hermes environment or `.env` file. Never commit or print the private key or session token.

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-hermes
ONCLAVE_PRIVATE_KEY=[REDACTED]
```

`ONCLAVE_PRIVATE_KEY` is the enrolled Ed25519 private key as 64 hexadecimal characters. An optional already-issued `ONCLAVE_SESSION_TOKEN` can be used for a running session; otherwise the plugin obtains a challenge and authenticates with the private key. The gateway operator must enroll and approve the agent before authentication succeeds.

Optional values:

```text
ONCLAVE_REQUEST_TIMEOUT=15
ONCLAVE_HEARTBEAT_INTERVAL=20
ONCLAVE_STATE_PATH=<profile-safe state path>
```

State contains only subscription/cursor and idempotency metadata. By default it is stored below `$HERMES_HOME/onclave-hermes/state.json`.

## Tools

- `onclave_status`: validates configuration without network access.
- `onclave_send`: submits a `task.assign` command to a target agent.
- `onclave_task`: reads task state.
- `onclave_inbox`: reads inbound command/event deliveries received by the background WSS session.
- `onclave_complete`: completes an inbound task after Hermes handles it.
- `onclave_fail`: reports failure for an inbound task.
- `onclave_cancel`: requests cancellation where gateway ownership policy permits it.
- `onclave_subscribe`: creates or reuses an agent-scoped durable subscription.
- `onclave_disconnect`: clears the cached controller.

Inbound WSS is started lazily when a network tool first initializes the plugin. Deliveries are acknowledged, marked started, and placed in the bounded `onclave_inbox`; Hermes can then process them and report `onclave_complete` or `onclave_fail`. The controller deduplicates by both `messageId` and `taskId`, and `onclave_disconnect` stops the background session.

## Security and delivery behavior

- Only HTTPS/WSS gateway URLs are accepted.
- Challenge signatures and bearer tokens are never written to the audit log.
- Unknown gateway response fields are tolerated.
- Duplicate command deliveries do not execute twice.
- Lifecycle reporting supports acknowledgement, start, progress, completion, failure, and cancellation.
- Subscription cursors advance only after event acceptance and are monotonic.
- Network errors retain gateway status context without including credentials.

## Tests

From the repository root:

```bash
PYTHONPATH=extensions/onclave-hermes python -m pytest extensions/onclave-hermes/tests -q
python -m unittest discover -s adapters/hermes -p 'test_*.py' -v
```

The extension tests are hermetic and do not require RabbitMQ. A live acceptance test must use only an explicitly configured Onclave HTTPS/WSS endpoint and a disposable approved agent:

```bash
python extensions/onclave-hermes/scripts/gateway_acceptance.py
ONCLAVE_ACCEPTANCE_REQUIRED=1 python extensions/onclave-hermes/scripts/gateway_acceptance.py
```
