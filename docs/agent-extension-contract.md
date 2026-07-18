# Onclave agent extension authoring contract

This document defines how to create an agent extension that interacts with
Onclave.

The public boundary is the Onclave HTTPS/WebSocket gateway contract. Extensions
must not connect to RabbitMQ, import gateway service internals, or depend on
SQLite schemas. See [the gateway contract](./agent-gateway.md) for the wire API.

## Repository placement

Use these top-level boundaries:

```text
extensions/
  <extension-name>/              # host/harness extension package
    package.json                  # package metadata and host entrypoints
    README.md                     # user and installation documentation
    onclave.extension.json        # language-neutral extension manifest
    src/                          # runtime implementation
      index.ts                    # or the host-language entrypoint
      gateway/                    # gateway client/session integration
      host/                       # host/harness integration
    tests/                        # unit, contract, and host integration tests
    fixtures/                     # redacted protocol fixtures, when needed
    scripts/                      # local acceptance and development helpers

adapters/
  <runtime-name>/                 # runtime adapter, not a host extension

packages/
  onclave-comms-protocol/         # shared schemas, validators, fixtures

services/
  onclave/                        # gateway implementation; extensions do not import it
```

`extensions/onclave-pi` is the first-party Pi extension and follows the
extension layout. `extensions/onclave-hermes` is the first-party Hermes
extension and is the canonical Hermes integration for the public gateway.
Runtime-specific gateway clients belong inside their corresponding extension
unless they are independently maintained, reusable packages. Do not create
empty adapter or package directories in advance.

## Manifest

Every distributable extension must contain `onclave.extension.json`:

```json
{
  "manifestVersion": 1,
  "id": "com.example.onclave-my-extension",
  "name": "my-extension",
  "version": "0.1.0",
  "runtime": "pi",
  "entrypoint": "./src/index.ts",
  "protocolVersion": "v1",
  "gateway": {
    "requiredCapabilities": ["message.receive"],
    "supportsSubscriptions": true,
    "supportsTaskLifecycle": true
  }
}
```

Manifest requirements:

- `manifestVersion` is the manifest format version, not the gateway version.
- `id` is globally unique, stable, lowercase, and reverse-domain or repository
  scoped. It must not be reused for an unrelated extension.
- `name` is a short package/display name and must match the package metadata
  where the host package format requires a name.
- `version` follows Semantic Versioning.
- `runtime` identifies the host or harness (`pi`, `hermes`, or another named
  runtime); it is not an authorization claim.
- `entrypoint` is relative to the extension root and must remain inside it.
- `protocolVersion` identifies the gateway/protocol contract the extension was
  tested against.
- `requiredCapabilities` must be the minimum set; extensions must degrade
  gracefully when optional capabilities are unavailable.

The manifest is descriptive. Enrollment, approval, capability policy, and
session tokens are controlled by the gateway/operator and must never be
embedded in the manifest.

## Required implementation behavior

An extension must:

1. Load and validate its configuration without making network calls at module
   import time.
2. Keep the gateway URL, agent ID, key material, and session token out of source
   control and logs.
3. Use the challenge-response enrollment/authentication flow described in the
   gateway contract.
4. Request only the capabilities it actually needs.
5. Use HTTPS/WSS and send the bearer token only to the configured gateway.
6. Use the public HTTP/WebSocket API or a maintained protocol client; never use
   RabbitMQ queue names, exchanges, credentials, or SQLite files.
7. Handle heartbeat, session expiry, WebSocket closure, reconnect, and gateway
   errors explicitly.
8. Treat command delivery as at-least-once: acknowledge only after the host has
   accepted the command, and make task handling idempotent by `messageId` and
   `taskId`.
9. Report task lifecycle state with the ownership rules in the gateway contract:
   `task.ack`, `task.started`, `task.progress`, `task.completed`,
   `task.failed`, and `task.cancelled` where applicable.
10. Close WebSocket sessions, timers, file handles, and host registrations on
    shutdown.

## Common host commands

Extensions may translate these commands into native host tools, slash
commands, UI actions, or another host-specific interface. The host-facing
names and schemas below are the common vocabulary; the gateway wire contract
remains authoritative for HTTP, WebSocket, and lifecycle message details.

### Required commands

Every extension that exposes task submission must provide these commands.
Extensions must preserve the canonical names and parameter meanings even when
their host uses a different presentation layer.

#### `onclave_status`

Report local extension readiness without making a network request by default.
The result should include normalized values such as:

```json
{
  "configured": true,
  "authenticated": true,
  "connected": true,
  "agent_id": "agent-example",
  "gateway_url": "https://onclave.example",
  "capabilities": ["message.send", "message.receive"]
}
```

The result must never contain private keys, bearer tokens, or other credential
material. An extension that cannot authenticate or connect should report the
state and a redacted diagnostic rather than exposing secret values.

#### `onclave_send`

Submit asynchronous work to an enrolled target agent. Canonical parameters:

```json
{
  "target_agent_id": "agent-executor",
  "instruction": "Run the test suite",
  "task_id": "optional-stable-task-id",
  "correlation_id": "optional-workflow-id",
  "expires_at": "optional RFC3339 timestamp"
}
```

`instruction` is the canonical task input name because it maps to the gateway
`task.assign` payload. A host may accept `prompt` as a temporary compatibility
alias, but new implementations and documentation must use `instruction`.

The normalized result should include at least `message_id`, `task_id`, and the
gateway-accepted state. Extensions must not keep the command request open while
the target performs work.

#### `onclave_task`

Read the current state of a task:

```json
{
  "task_id": "task-example"
}
```

The normalized result should preserve `task_id`, `state`, `progress`, `note`,
`result`, `created_at`, and `updated_at` when supplied by the gateway. Unknown
gateway fields must be tolerated.

`onclave_get` is not the canonical name. Existing extensions may retain it as
a temporary alias, but new code must use `onclave_task`.

#### `onclave_cancel`

Request cancellation of an owned task:

```json
{
  "task_id": "task-example",
  "reason": "No longer needed"
}
```

Cancellation is subject to gateway ownership and policy checks. An accepted
cancellation request does not guarantee that work stopped; the extension must
return or make available the resulting task state.

An extension may omit this command only when its negotiated gateway contract
does not support cancellation. The omission must be reflected in its
documentation and tests.

### Recommended convenience command

#### `onclave_await`

Wait for a task to reach a terminal state:

```json
{
  "task_id": "task-example",
  "timeout_ms": 30000
}
```

Terminal states are `completed`, `failed`, `cancelled`, and `expired`. The
result should use the same normalized task shape as `onclave_task`. An
extension may implement this with polling, WebSocket events, or durable replay;
it must cap the timeout and must not make the host session unbounded.

### Inbound task handling

Inbound delivery is a common behavior, not necessarily a user-facing command.
An extension must map a gateway `command.delivery` into a host event with this
normalized shape:

```json
{
  "message_id": "message-example",
  "task_id": "task-example",
  "correlation_id": "workflow-example",
  "source_agent_id": "agent-planner",
  "target_agent_id": "agent-executor",
  "message_type": "task.assign",
  "payload": {"instruction": "Run the test suite"}
}
```

The host may inject the instruction into an active conversation, buffer it in
an inbox, or dispatch it to a job runner. The presentation is host-specific;
acknowledgement, idempotency, and lifecycle reporting remain mandatory.

For hosts that expose manual inbound handling, use these optional commands:

- `onclave_inbox` reads buffered inbound commands/events;
- `onclave_complete` reports `{ "task_id": "...", "result": {} }`;
- `onclave_fail` reports `{ "task_id": "...", "error": "..." }`.

Hosts that handle inbound work automatically may implement completion and
failure through lifecycle hooks instead of exposing these as model-facing
commands.

### Subscription and lifecycle commands

`onclave_subscribe` is optional and requires `supportsSubscriptions: true` in
the extension manifest. Its pattern must remain agent-scoped, and the
extension must persist the subscription lease and cursor according to the
subscription rules below.

`onclave_disconnect` is an optional operational action. Extensions must always
close sessions during host shutdown even if they do not expose a user-facing
disconnect command.

### Common naming and result rules

Common commands must use these names for cross-runtime interoperability:

- `task_id`, `message_id`, and `correlation_id` for identifiers;
- `target_agent_id` and `source_agent_id` for agent identities;
- `instruction` for submitted task text;
- `expires_at`, `created_at`, and `updated_at` for RFC3339 UTC timestamps;
- `result` for successful task output and `error` for failure context.

Command results must preserve gateway status/code context, avoid raw HTTP
response coupling, and never include credentials. Command tests must cover
parameter validation, normalized results, gateway errors, duplicate delivery,
and ownership failures.

## Subscriptions and replay

Extensions that observe events should prefer the durable subscription API:

- create a subscription with an agent-scoped pattern;
- persist the returned `subscriptionId` in host state, not source code;
- renew the lease before expiry;
- reconnect with `subscriptionId`;
- process replay before treating the session as live;
- persist the returned cursor only after the extension has accepted the event;
- use a task-specific cursor for one task or a global cursor for broad event
  observation.

A subscription may narrow visibility with `taskId` or `correlationId`, but it
must never widen the authenticated agent scope.

## Host integration boundary

Host-specific behavior belongs behind a small extension-owned boundary:

```text
src/host/
  commands.ts       # map host actions to gateway commands
  events.ts         # map gateway events to host notifications
  lifecycle.ts      # startup, reconnect, shutdown
```

The host layer may translate gateway messages into native tools, commands, or
UI events. It must not change the gateway wire contract silently. If a new
wire field or message type is needed, update the shared protocol schemas and
compatibility tests first.

## Testing and conformance

Every extension must provide:

- manifest validation tests;
- protocol fixture tests using
  `packages/onclave-comms-protocol` where the language supports it;
- authentication and capability-policy tests with redacted credentials;
- command serialization and lifecycle tests;
- duplicate delivery/idempotency tests;
- reconnect, heartbeat, lease-renewal, and subscription replay tests;
- shutdown/cleanup tests;
- a non-destructive gateway integration test when a gateway environment is
  available.

Tests must not require RabbitMQ credentials or direct broker access. Live
integration tests use the gateway HTTP/WebSocket boundary and may use the
repository's isolated Compose acceptance stack.

The minimum handoff checks are:

```bash
pnpm run check                 # TypeScript extensions/protocol
# extension-specific test command, documented in its README
# gateway integration acceptance, when enabled
```

## Versioning and compatibility

- Patch releases fix implementation defects without changing the gateway
  contract.
- Minor releases may add optional capabilities, fields, or message handling.
- Major releases are required for incompatible gateway assumptions.
- Unknown response fields must be ignored.
- Extensions must not fail because an optional event field is absent.
- Gateway errors must preserve status/code context for operator diagnostics.

## Security rules

Never commit or print:

- private keys;
- session tokens;
- broker passwords or URLs containing credentials;
- unredacted enrollment material;
- sensitive task payloads in audit output.

Use `[REDACTED]` in documentation, fixtures, logs, and test output. Extensions
are untrusted clients from the gateway's perspective: authentication,
capabilities, ownership, expiry, and replay authorization are enforced by the
gateway, not by extension convention.
