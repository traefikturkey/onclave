# Onclave

Onclave provides a containerized core service and a Pi adapter for durable,
provider-neutral communication between independent Pi instances.

## Architecture

- `packages/envelope` defines the incompatible v2 `ChannelMessage` contract and
  the separate independent `Task` and task-status contracts.
- `services/core` owns the private instance registry, channel aggregates,
  durable broker delivery, persistence, authentication, audit, and task APIs.
- `extensions/onclave-pi` is the supported Pi adapter. It exposes peer
  discovery and one explicit channel-message tool, and delivers inbound events
  into Pi.
- `deploy` and `infra` contain provider-neutral deployment assets.

Onclave is not a general A2A server. It uses a bounded A2A-derived subset for
communication between independent Onclave instances. MCP remains a tool and
context integration surface. Pi-local subagents remain inside their parent Pi
process and are not Onclave instances.

## Asynchronous channel model

Channel messages use `protocol_version: 2` and one envelope:

```ts
type ChannelMessage = {
  protocol_version: number;
  channel_id: string;
  message_id: string;
  sequence: number;
  kind: "request" | "response" | "note";
  origin: A2AOrigin;
  participants: string[];
  body: string;
  sent_at: string;
  response_requested_from?: string[];
  response_policy?: "any" | "all";
  in_reply_to?: string;
  usage?: A2AUsage;
  schema?: string;
};
```

A channel is a core-owned logical aggregate, not a model-managed object or a
RabbitMQ exchange. The core creates or reuses an open channel for the exact
normalized participant set. It assigns channel and message IDs, timestamps,
and monotonic per-channel sequence numbers. Full registered instance IDs are
used on the wire; the Pi adapter resolves short aliases before posting.

The semantic kinds are:

- `request` names one or more recipients from whom a response is expected. A
  single recipient defaults to `all`; a group defaults to `any`. A group may
  explicitly request `all`.
- `response` answers a prior request through `in_reply_to`. The core checks the
  request relationship and counts each named responder once. Unexpected or
  duplicate responses remain channel history but do not satisfy the request.
- `note` carries information only and has no response expectation.

Every accepted event is persisted before the post is acknowledged and is fanned
out through the existing durable `agent.<full-instance-id>` mailboxes. RabbitMQ
is at-least-once: adapters retain leases across handling failures and deduplicate
message IDs. Channel satisfaction is persisted as `open` or `satisfied` with
its expected policy and responders received. There are no channel deadlines,
unread cursors, cancellation workflows, or synchronous waits in this surface.

Examples of the model-facing forms:

```json
{"kind":"request","to":["pi-a"],"body":"Check the deployment status."}
{"kind":"request","to":["pi-a","pi-b"],"body":"Can either of you identify the failure?"}
{"kind":"request","to":["pi-a","pi-b"],"response_policy":"all","body":"Each instance should report its result."}
{"kind":"note","to":["pi-a"],"body":"Deployment completed."}
```

A response during the active inbound request turn is simply:

```json
{"body":"Deployment is healthy."}
```

The adapter supplies `kind: "response"`, the channel, the original request
link, and the destination. Outside an active request, an advanced response may
provide `kind`, `channel_id`, and `in_reply_to`. New requests and notes require
`kind`, `to`, and `body`; `body` is always required. Models do not supply sender
identity, origin metadata, IDs, timestamps, sequence, task IDs, trace IDs, or
broker routing details.

A request starts a Pi turn only at instances named as responders. Other channel
participants receive a display notification. Responses and notes are delivered
as display-only events and never automatically trigger another model turn. The
only model-originated channel publication is an explicit `onclave_message` call;
settled assistant text is never silently published.

## Independent tasks

The existing task primitives remain a separate API. Tasks use their own protocol
version and retain the states `submitted`, `working`, `input-required`,
`completed`, `failed`, `canceled`, and `rejected`, with terminal immutability.
Task status events are durably routed to their origin, but channel messages do
not create, complete, or cancel tasks. This milestone does not redesign the task
system.

## Prerequisites

Run the bootstrap preflight for your shell before installing dependencies.

### PowerShell

```powershell
pwsh -File ./scripts/preflight.ps1
```

### Bash, Git Bash, WSL, Linux, or macOS

```bash
bash ./scripts/preflight.sh
```

The scripts check for Node.js, pnpm, just, Git, and the optional local Pi
installation. Repository-wide requirements are documented in
[Development Environment](./docs/guides/development-environment.md).

## Development

```bash
just setup
just check
just test-integration
```

- `just setup` installs the pnpm workspace.
- `just check` runs TypeScript typechecking and unit tests.
- `just test-integration` runs the broker-backed integration suite.
- `just core-dev` starts the core service in watch mode.

## Pi adapter

Load the supported adapter from this checkout:

```bash
just pi-local
```

Equivalent command:

```bash
pi -e ./extensions/onclave-pi
```

The adapter requires Pi 0.85.x and connects orchestrators: the primary models
users interact with in independent Pi instances. Subagents must not use Onclave
for communication with subagents or other instances.

Normal Pi processes load the adapter. Pi subagents do not load it when
`PI_SUBAGENT_RUN_ID` or `PI_SUBAGENT_TREE_RUN_ID` is present.

The adapter registers the current Pi session as an independent Onclave
instance. Its model-facing tools are:

- `onclave_instances`, which lists live registered instances, short aliases,
  full routing IDs, and liveness evidence;
- `onclave_message`, which explicitly posts a `request`, `response`, or `note`
  using the forms described above.

Tool validation rejects task, context, timeout, and retired message fields
before publication. `onclave_message` is intended for user-directed
orchestrator communication, not delegation, review, provider fallback, local
execution, or autonomous workload distribution.

Inbound peer bodies are framed as untrusted data. Authentication binds a
registered instance to its signing key; it does not grant peer content
operator authority. On the protected VLAN/tailnet, requests are accepted
without routine host confirmation or host allowlist setup. `/onclave` reports
registration, connection, identity, and live peers. The footer uses the
`onclave-v2` status key.

The dotfiles integration loads the same adapter through
`pi/profiles/default/extensions/onclave-pi.ts` and the existing loader. Both use
this implementation and its trusted-network acceptance behavior. The adapter
obtains `ONCLAVE_API_BASE` from the configured secret source and signs API
requests with the local SSH identity.

Package metadata also supports local or Git installation:

```bash
pi install .
pi install git:git@github.com:traefikturkey/onclave.git
```

## Future integration seam

Authenticated webhook ingress for external events is reserved as a future
server-side seam. A later adapter can classify an authenticated, idempotent
event as a `note` or `request` for a Pi or Hermes consumer. No webhook endpoint,
Hermes adapter, MCP face, public Agent Card discovery, or complete A2A server is
delivered here.

## Protocol break

Protocol v2 is intentionally incompatible with the retired point-to-point
communication surface. Core and adapters must be upgraded together; mixed
versions are rejected explicitly. No compatibility translation or live broker
cutover is delivered by this repository change.

## Documentation

- [Pi adapter PRD](./docs/extensions/onclave-pi/PRD.md)
- [Pi adapter implementation plan](./docs/extensions/onclave-pi/implementation-plan.md)
- [Pi adapter status](./docs/extensions/onclave-pi/status.md)
- [Development environment](./docs/guides/development-environment.md)
