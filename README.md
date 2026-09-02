# Onclave

Onclave provides a containerized core service and a Pi adapter for durable,
provider-neutral communication between independent Pi instances.

## Architecture

- `packages/envelope` defines the versioned A2A-derived `Message`, `Task`, and
  task status event contracts.
- `services/core` owns the private instance registry, durable broker delivery,
  context and task state, policy checks, budgets, audit, and origin event
  routing.
- `extensions/onclave-pi` is the supported Pi adapter. It exposes instance
  discovery and one message tool, and delivers inbound content into Pi.
- `deploy` and `infra` contain provider-neutral deployment assets.

Onclave is not a general A2A server. It uses a bounded subset for communication
between independent Onclave instances. MCP remains a tool and context
integration surface. Pi-local subagents remain inside their parent Pi process
and are not Onclave instances.

## Bounded message and task model

The wire contract uses A2A-derived messages with `protocol_version: 1`, a
`message_id`, `context_id`, optional `task_id`, origin and destination, body,
timestamps, hop and trace metadata, and optional usage data. Supported message
types are:

- `ask` sends a direct turn-triggering message and waits once for a direct reply
  or an interrupted or terminal task result, bounded by `timeout_ms`.
- `request` publishes asynchronously and returns message and context
  identifiers after durable publication. The receiver creates the task and
  emits `submitted`; publication is not receiver acceptance.
- `inform` sends point-to-point or broadcast information, creates no task,
  expects no reply, and never triggers a turn.

Tracked tasks use `submitted`, `working`, `input-required`, `completed`,
`failed`, `canceled`, and `rejected`. Terminal tasks are immutable. A reply can
continue a nonterminal `input-required` task. Refinement after a terminal task
creates a new task in the same context and may reference the prior task.
Status events are durably routed to the originating instance, so the model
need not manage callbacks or wait loops.

RabbitMQ acknowledgements and the adapter HTTP `202` response describe
transport handling only. `submitted` is the application-level acceptance event
for task tracking. Neither transport acknowledgement nor peer identity gives a
message operator authority; peer content remains untrusted input and
cross-host turn-triggering messages require operator confirmation unless an
explicit local policy accepts that host.

The version break is intentional. Incompatible protocol versions fail
explicitly; this surface does not promise wire compatibility with the retired
six-tool communication model.

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

Normal Pi processes load the adapter. Pi subagents do not load it when
`PI_SUBAGENT_RUN_ID` or `PI_SUBAGENT_TREE_RUN_ID` is present.

The adapter registers the current Pi session as an independent Onclave
instance. Its only model-facing tools are:

- `onclave_instances` lists live registered instances and evidence-backed
  status.
- `onclave_message` accepts `ask`, `request`, or `inform` with conditional
  `to`, `body`, `context_id`, `task_id`, and `timeout_ms` fields.

Outbound discovery and messaging are operator-directed. The tools may continue
an already operator-directed Onclave workflow, but they do not replace Pi-local
subagents, reviewers, failed delegation, provider fallback, or local execution.

The dotfiles integration loads the same adapter through
`pi/extensions/onclave-pi.ts`. The adapter obtains `ONCLAVE_API_BASE` from the
configured secret source and signs API requests with the local SSH identity.

Package metadata also supports local or Git installation:

```bash
pi install .
pi install git:git@github.com:traefikturkey/onclave.git
```

## Future integration seam

Authenticated webhook ingress for external events is reserved as a future
server-side seam. A later adapter can classify an authenticated, idempotent
event as `inform` or `request` for a Pi or Hermes consumer. No webhook endpoint,
Hermes adapter, MCP face, public Agent Card discovery, or complete A2A server is
delivered here.

## Documentation

- [Pi adapter PRD](./docs/extensions/onclave-pi/PRD.md)
- [Pi adapter implementation plan](./docs/extensions/onclave-pi/implementation-plan.md)
- [Pi adapter status](./docs/extensions/onclave-pi/status.md)
- [Development environment](./docs/guides/development-environment.md)
