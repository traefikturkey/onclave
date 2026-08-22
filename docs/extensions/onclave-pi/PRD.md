---
created: 2026-07-17
status: active
implementation_plan: ./implementation-plan.md
---

# PRD: Onclave A2A-Derived Message and Task Model

## Product boundary

Onclave connects independent Pi instances through an Onclave core service and
durable delivery. It is not a hierarchy of parent and child agents, and Pi-local
subagents are outside Onclave. The adapter is a transport and session
integration, not a second agent runtime.

This milestone adopts only the high-value A2A 1.0-derived subset needed for
independent-instance communication:

- `Message` with `message_id`, `context_id`, optional `task_id`, origin,
  destination, body, timestamps, hop and trace metadata, and optional usage.
- `Task` with immutable identity, context, origin instance, assigned instance,
  usage, timestamps, and status events.
- Task states `submitted`, `working`, `input-required`, `completed`, `failed`,
  `canceled`, and `rejected`.
- Durable status events routed back to the originating instance.

The model-facing schema is one flat, provider-portable object with a required
`type` enum. Conditional validation is deterministic in the adapter; it does
not depend on provider-specific root unions.

This is not full A2A adoption. Onclave does not deliver public Agent Card
discovery, skills, artifacts, multimodal parts, SSE, gRPC, webhooks, task
search, or a general A2A server. `auth-required` is deferred until there is an
executable cross-instance authentication workflow.

## Message types

### `ask`

`ask` is direct, turn-triggering communication. The sender supplies `to` and
`body`, and may supply `context_id`, `task_id`, and `timeout_ms`. The adapter
waits once for a direct response or an interrupted or terminal task result.
Timeout bounds the wait only; it does not cancel a created task.

### `request`

`request` is asynchronous tracked work. The sender publishes and returns its
`message_id` and `context_id` after durable publication. The receiver creates a
task and emits `submitted` with the receiver-created task ID. A successful
transport publication is not application acceptance by the receiver.

### `inform`

`inform` is point-to-point or broadcast information. It creates no task,
expects no response, and is delivered for display and context only. It cannot
start a Pi turn or tool call.

## Task lifecycle

A receiver creates a task for `ask` and `request` messages, then emits
`submitted` before progressing the task. The normal lifecycle is:

```text
submitted -> working -> completed
                    -> input-required -> working -> completed
```

`submitted` may instead move to `input-required`, `failed`, `canceled`, or
`rejected`. `working` may remain `working`, request input, or become
`completed`, `failed`, or `canceled`. `input-required` may resume as `working`,
complete, fail, or cancel. `completed`, `failed`, `canceled`, and `rejected` are
terminal and immutable.

A reply can continue an `input-required` nonterminal task. Continuing a
terminal task is rejected. A refinement after a terminal task creates a new
task in the same context and may carry `prior_task_id`. Task status events are
returned to the origin through durable delivery. `input-required` and terminal
status events can trigger a caller turn; intermediate status is display-only.
No model-managed callback registration or wait loop is required.

## Delivery, acceptance, and authority

RabbitMQ delivery acknowledgement, core publication, and the adapter's signed
HTTPS `202` response are transport-level handling. They indicate that the
message was accepted for delivery or publication, not that the receiving
instance accepted the work. `submitted` is the application-level acceptance
signal for tracking a task.

Authentication binds an instance to its registered identity and signing key; it
does not make peer content trustworthy or give peer content operator
authority. Every inbound body is framed as data to evaluate. Cross-host
turn-triggering messages require operator confirmation unless the operator has
explicitly configured acceptance for that host. `inform` remains inert even
when its body contains imperative text. Existing provenance framing,
deduplication, hop and exchange limits, advisory usage budgets, audit
redaction, offline delivery, and restart-safe status routing remain core
controls.

The adapter acknowledges or rejects deliveries after its handling decision.
Duplicate message and status identifiers are acknowledged without repeating
side effects.

## Adapter surface

The adapter registers exactly two model-facing tools:

- `onclave_instances`: parameterless discovery of live registered independent
  Pi instances with evidence-backed status.
- `onclave_message`: one flat schema with required `type`, `to` except for
  broadcast `inform`, and `body`; optional `context_id`, `task_id`, and
  `timeout_ms` are accepted only where applicable.

`ask` requires a direct destination and may use a timeout. `request` requires a
direct destination and returns after publication. `inform` may target one
instance or broadcast, cannot carry task or timeout fields, and never triggers
a turn. Invalid combinations fail before publication.

The adapter excludes Pi-local subagent runs from registration. Onclave connects
independent instances; it does not expose local Pi subagents as remote
instances or treat them as Onclave participants.

## Relationship to MCP, A2A, and Hermes

MCP is a tool and context integration protocol. It is not the communication
semantics defined here, and no MCP face is delivered in this milestone.
A2A-derived `Message`, `Task`, context, and status semantics govern
communication between independent Onclave instances. Pi subagents remain local
to Pi and use Pi's own subagent mechanisms.

Authenticated webhook ingress is a future evolution seam. An external source
could later submit an authenticated, idempotent event that server-side policy
classifies as `inform` or `request` for a Pi adapter or a future Hermes adapter.
The endpoint, authentication workflow, external event adapter, and Hermes
consumer are not delivered here.

## Protocol break

The protocol version is explicit and incompatible versions fail explicitly.
This milestone does not preserve the retired custom communication wire or its
six-tool model-facing surface. Documentation and prompts must use only
`instance`, `message`, `context`, and `task` terminology.

There is no compatibility promise for prior peers. Deployment must upgrade the
core and adapters as one protocol boundary; no live cutover is part of this
milestone.

## Non-goals

- Full A2A server or public discovery.
- MCP or Hermes adapters.
- Authenticated webhook endpoint implementation.
- Live deployment, broker cutover, or infrastructure changes.
- Peer messages cannot transfer operator authority.
- A second Pi communication adapter.

## Acceptance evidence

Documentation is aligned when maintainers can trace:

1. Message fields and the three message-type behaviors.
2. Every task transition, terminal immutability, continuation, and same-context
   refinement.
3. Transport handling versus `submitted` application acceptance.
4. Instance identity versus operator authority.
5. The explicit protocol-version break and two-tool adapter surface.
6. The distinction between MCP integration, A2A-derived instance semantics, and
   Pi-local subagents.
7. The future authenticated webhook and Hermes seam as not delivered.

Executable acceptance remains the responsibility of the shared-contract,
adapter, and broker integration suites. This documentation pass does not
change those suites or live systems.
