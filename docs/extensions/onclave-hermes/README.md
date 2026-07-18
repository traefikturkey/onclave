---
status: active
---

# Onclave Hermes Extension

`onclave-hermes` connects a Hermes Agent runtime to the public Onclave
HTTPS/WebSocket gateway. It is a runtime plugin, not a RabbitMQ client,
standalone gateway, or direct gateway-database integration.

For the public API contract, see [the agent gateway contract](../../agent-gateway.md).
For gateway deployment and enrollment, see [the development environment guide](../../guides/development-environment.md).

## Install

### From a repository checkout

Clone or open the Onclave repository, create the Hermes plugin directory, and
copy the extension into the active Hermes profile:

```bash
git clone https://github.com/traefikturkey/onclave.git
cd onclave
mkdir -p "$HERMES_HOME/plugins/onclave-hermes"
cp -R extensions/onclave-hermes/. "$HERMES_HOME/plugins/onclave-hermes/"
```

If `HERMES_HOME` is not set, use the plugin directory for the active Hermes
profile. Do not copy the repository's `.env` files or credential files.

Install the extension's Python dependencies in the environment used by Hermes:

```bash
python -m pip install -r "$HERMES_HOME/plugins/onclave-hermes/requirements.txt"
```

The plugin entrypoint is:

```text
$HERMES_HOME/plugins/onclave-hermes/__init__.py
```

Its manifest is `onclave.extension.json`; `plugin.yaml` lists the tools and
required non-secret environment variables.

### Enable the plugin

Use the Hermes CLI for the active profile:

```bash
hermes plugins enable onclave-hermes
hermes plugins list
```

Restart the Hermes Agent process after enabling or updating the plugin. If the
CLI uses an explicit profile, run these commands with that profile selected.

## Configuration

Set the gateway endpoint and enrolled agent identity in the Hermes environment.
The gateway operator must enroll and approve the agent before authentication can
succeed.

```text
ONCLAVE_GATEWAY_URL=https://onclave.example
ONCLAVE_AGENT_ID=agent-hermes
ONCLAVE_PRIVATE_KEY=<64 lowercase hexadecimal characters>
```

`ONCLAVE_PRIVATE_KEY` is the enrolled Ed25519 private key. Never commit it,
place it in a public fixture, or print it in logs.

Optional settings:

```text
ONCLAVE_SESSION_TOKEN=<short-lived session token, if supplied>
ONCLAVE_REQUEST_TIMEOUT=15
ONCLAVE_HEARTBEAT_INTERVAL=20
ONCLAVE_STATE_PATH=<profile-safe state path>
```

When `ONCLAVE_SESSION_TOKEN` is absent, the plugin obtains a gateway challenge
and signs it with `ONCLAVE_PRIVATE_KEY`. The plugin stores subscription cursors
and idempotency metadata under its state path; it does not store gateway
credentials in source-controlled files.

## Use the tools

The plugin exposes these Hermes tools:

| Tool | Use |
|---|---|
| `onclave_status` | Validate local configuration without a network call. |
| `onclave_send` | Submit a task to an enrolled target agent. |
| `onclave_task` | Read task state by task ID. |
| `onclave_inbox` | Read inbound commands/events received by the WSS session. |
| `onclave_complete` | Complete an inbound task after Hermes handles it. |
| `onclave_fail` | Report failure for an inbound task. |
| `onclave_cancel` | Request cancellation when gateway policy permits it. |
| `onclave_subscribe` | Create or reuse an agent-scoped durable event subscription. |
| `onclave_disconnect` | Stop the background WSS session and clear the controller. |

Typical workflow:

1. Run `onclave_status` and correct configuration errors.
2. Run `onclave_send` with `target_agent_id` and `instruction`.
3. Keep the returned task ID.
4. Use `onclave_task` to inspect state, or subscribe to task events with
   `onclave_subscribe`.
5. For inbound work, read `onclave_inbox`, handle the instruction, then call
   `onclave_complete` or `onclave_fail` with the same task ID.
6. Run `onclave_disconnect` when intentionally ending the background session.

The plugin requests `message.send` and `message.receive` capabilities. Inbound
commands are acknowledged and marked started before they are placed in the
bounded inbox. Duplicate deliveries are deduplicated by message and task ID.

## Security and delivery behavior

- Gateway URLs must use HTTPS; the session uses authenticated WSS.
- The plugin never connects directly to RabbitMQ or reads gateway SQLite files.
- Challenge signatures and bearer tokens are not written to audit output.
- Task and event identifiers are preserved for correlation and idempotency.
- Subscription cursors advance only after accepted event delivery.
- Network errors retain gateway status context without exposing credentials.
- Push or notification integrations must not receive raw prompts or secrets.

## Test and acceptance checks

From the repository root:

```bash
PYTHONPATH=extensions/onclave-hermes python -m pytest extensions/onclave-hermes/tests -q
```

Run the non-destructive gateway health acceptance check with a configured,
approved agent:

```bash
python extensions/onclave-hermes/scripts/gateway_acceptance.py
ONCLAVE_ACCEPTANCE_REQUIRED=1 python extensions/onclave-hermes/scripts/gateway_acceptance.py
```

The first command reports a skipped acceptance when the gateway is unavailable;
the `ONCLAVE_ACCEPTANCE_REQUIRED=1` form returns failure instead. Do not use
real credentials in test output or commit acceptance logs.
