# onclave-pi Pi Extension

This package connects Pi to the public Onclave HTTPS/WebSocket gateway.
It does not connect to RabbitMQ, SQLite, or local hub transports.

## Configuration

Before starting Pi, configure:

- `ONCLAVE_GATEWAY_URL`: HTTPS gateway base URL.
- `ONCLAVE_AGENT_ID`: approved gateway agent ID.
- The matching Ed25519 private key in Pi's Onclave state directory.

Enrollment and operator approval are performed through the gateway deployment;
the extension does not expose enrollment credentials or session tokens.

## Local loading

From the repository root:

```bash
just setup
pi -e ./extensions/onclave-pi
```

The extension authenticates on `session_start`, requests only
`message.send` and `message.receive`, and closes its authenticated session on
shutdown.

## Tools

- `onclave_send`: submit a task to an enrolled target agent.
- `onclave_get`: retrieve task state.
- `onclave_await`: wait for terminal task state.

Commands delivered by the gateway are acknowledged only after Pi accepts them;
completion and failure are reported through the gateway task lifecycle.
