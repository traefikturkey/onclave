---
created: 2026-07-17
status: aligned
source_prd: ./PRD.md
branch: feature/v2-broker-core
---

# Implementation Plan: Onclave A2A-Derived Message and Task Boundary

## Purpose

This document records the implementation boundary for the independent core and
Pi adapter on `feature/v2-broker-core`. The core owns durable delivery and
provider-neutral protocol state. The Pi adapter owns the last hop into a live Pi
session. The model-facing contract is deliberately small and is not a complete
A2A or MCP implementation.

## Runtime boundary

The core provides:

- a private registry of independently registered Pi instances;
- durable RabbitMQ-backed message and task-status delivery;
- versioned message validation and explicit protocol-version rejection;
- persisted contexts, immutable tasks, task status events, usage, audit, trust
  checks, and origin routing; and
- signed HTTPS routes used by adapters to register, publish, receive, and
  disposition deliveries.

The Pi adapter provides:

- registration and liveness heartbeats for one independent Pi instance;
- `onclave_instances` for live instance discovery;
- `onclave_message` for `ask`, `request`, and `inform`;
- validation before publication and deduplication on receipt;
- turn-triggering delivery for `ask` and `request`, inert display delivery for
  `inform`, and status delivery for task events; and
- strict correlation between an inbound message and its Pi run.

Pi-local subagent runs are not registered and are not addressed by this
protocol. The dotfiles loader remains a thin loader and is outside this
implementation boundary.

## Shared contract

The versioned A2A-derived package defines:

```text
Message: message_id, context_id, optional task_id, type, origin, destination,
         body, sent_at, hops, optional ttl_ms, usage, schema, trace_id
Task:    task_id, context_id, origin instance, assigned instance, state, usage,
         timestamps, optional prior_task_id
Event:   event_id, task_id, context_id, origin instance, destination, state,
         timestamp, optional message, body, usage, and trace data
```

The supported message types are `ask`, `request`, and `inform`. The supported
task states are `submitted`, `working`, `input-required`, `completed`,
`failed`, `canceled`, and `rejected`. The version is explicit. A message or
status event with another version is rejected as a protocol mismatch.

The schema uses one required `type` enum and a flat object. Conditional fields
are checked in adapter code:

| Type | Required behavior | Optional fields |
| --- | --- | --- |
| `ask` | direct destination; wait once for response or task result | `context_id`, `task_id`, `timeout_ms` |
| `request` | direct destination; publish asynchronously and return identifiers | `context_id`, `task_id` |
| `inform` | point-to-point or broadcast; no task, reply, or turn | `context_id` |

Invalid combinations fail before publication.

## Task processing

For `ask` and `request`, the receiving adapter creates or resumes the tracked
task and the core persists a `submitted` event to the origin. The adapter then
records `working` before handing the framed message to Pi. A Pi response is an
`inform` message carrying the context and usage; when a task exists, the core
also records `completed`, `failed`, or `canceled` according to the settled Pi
outcome and routes that status event to the origin. Automatic retries finish
before the adapter publishes an outcome. The adapter does not infer
`input-required` from prose.

The transition table is:

| Current | Allowed next states |
| --- | --- |
| `submitted` | `working`, `input-required`, `failed`, `canceled`, `rejected` |
| `working` | `working`, `input-required`, `completed`, `failed`, `canceled` |
| `input-required` | `working`, `completed`, `failed`, `canceled` |
| terminal | none; repeated same-state events are idempotent |

An `input-required` task can be resumed with the same task and context. A
terminal task cannot be reopened. A later refinement creates a new task in the
same context and can reference the prior task. Status events go to the
originating instance and do not require model-managed subscriptions or wait
loops. Only correlated `input-required` and terminal events trigger an origin
turn. Intermediate status does not finish a pending ask. Correlation is
session-local, without restart/reload recovery.

`ask` timeout affects the sender's wait only. It does not cancel a created task.
`request` returns after durable publication and does not claim that the receiver
has accepted the task. `inform` is display-only and cannot trigger a turn.

## Transport and application acceptance

RabbitMQ acknowledgements, core publication, signed HTTPS responses, and
adapter delivery disposition are transport concerns. The adapter's publish
route returns HTTP `202` after the core accepts the message for delivery. This
is not task acceptance by the receiver.

The receiver-created `submitted` status event is the application-level
acceptance event. Task transitions, replies, budgets, trust checks, and origin
status routing are application behavior. The model does not acknowledge
transport messages, register callbacks, or manage delivery wait state.

## Authority and safety

A registered identity proves which instance signed a message. It does not prove
that the body is safe and does not transfer operator authority. Peer content is
untrusted input. Requests from peers on the protected VLAN/tailnet are accepted
without routine confirmation or host allowlist setup. `inform` is inert
regardless of body wording. Provenance framing, deduplication, hop and exchange
limits, usage budgets, audit redaction, offline queues, and restart-safe state
remain enforced in code.

## Tool and integration boundary

Only these model-facing tools are registered:

- `onclave_instances`: parameterless, private-registry discovery.
- `onclave_message`: the single `ask`/`request`/`inform` message entry point.

MCP remains a future tool and context integration surface. A2A-derived
semantics apply to independent Onclave instances. Pi-local subagents remain
local and are excluded from registration. No MCP face, public Agent Card
discovery, or complete A2A server is planned in this change.

The core keeps a future server-side seam for authenticated webhook events. A
later implementation may classify an authenticated, idempotent external event
as `inform` or `request` for a Pi adapter or Hermes consumer. There is no
webhook endpoint, external ingress authentication workflow, or Hermes adapter
in this implementation.

## Protocol migration

This is a protocol break, not a compatibility layer. The supported version must
be negotiated or rejected explicitly by the core and adapter. The retired
six-tool communication surface, custom authority model, and old message
vocabulary are not active interfaces. Upgrade the core and adapters together;
no live deployment or broker cutover is included here.

## Development and validation commands

Run from the module root:

```bash
just setup
just check
just test-integration
just pi-local
```

Package equivalents are:

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm exec vitest run --config vitest.integration.config.ts
```

The T3 documentation boundary is validated by direct inspection of the
registered tool names and schemas, the message and task descriptions, the
protocol break, and the future-ingress statements. Full executable validation
requires the existing unit and broker integration suites; this documentation
change does not modify code or tests.
