---
created: 2026-09-15
status: aligned
source_prd: ./PRD.md
branch: task/asynchronous-channel-messaging
---

# Implementation Plan: Onclave Asynchronous Channel Boundary

## Purpose

This implementation coordinates one incompatible channel protocol across the
shared envelope, core service, RabbitMQ mapping, and Pi adapter. The core owns
durable channel state and mailbox fan-out. The adapter owns alias resolution,
model-facing validation, session-owned inbound response context, framing, and
the last hop into a live Pi session. The dotfiles loader remains a thin loader
outside this boundary.

The change is protocol v2. Core and adapter versions must move together. No
compatibility translation, live cutover, new broker topology, or new storage
system is included.

## Shared contract (T1)

`packages/envelope` exports `ChannelMessage`, `ChannelMessageKind`,
`ResponsePolicy`, `Channel`, `ChannelRequestState`, and `ChannelSatisfaction`.
A channel message contains the v2 protocol version, core-assigned channel and
message IDs, core-assigned sequence, semantic kind, origin, full participant
set, body, timestamp, optional response expectation/linkage, usage, and schema.
Channel messages contain no task ID or synchronous wait fields.

`request` requires recipients and derives named responders. One recipient uses
`all`; multiple recipients default to `any`, with explicit `all` supported.
`response` requires a valid request link and `note` has no response metadata.
The shared parser rejects malformed kinds, participant sets, IDs, response
policies, response links, timestamps, and protocol versions. `parseRpcRequest`
validates channel posts and channel retrieval operations separately from the
independent task operations.

The task and task-status types remain separately compilable under their own
protocol version. They are not translated into channel messages.

## Core aggregate and transport (T2)

`ChannelStore` persists only the channel identity and exact normalized
participants, next sequence, bounded accepted message history, bounded request
state, and idempotency keys. It serializes mutations, creates or reuses an open
channel for a participant set, assigns sequence numbers, persists before the
post resolves, and restores valid v2 state after restart.

For a request it persists expected responders, policy, responders received, and
open/satisfied state. A named responder counts once. Responses to a known
request are checked for channel membership, original-requester destination, and
linkage. Unexpected responders are retained as events but do not satisfy the
request. Duplicate posts return the original result without another fan-out.

The core authenticates the signed sender and validates recipient registration,
then publishes one canonical event to every participant's existing durable
`agent.<full-instance-id>` mailbox through the direct agent exchange. It does
not create per-channel exchanges or dynamic membership. Delivery remains
at-least-once, with existing leases, dead-letter handling, offline queues,
audit, and bounded consumer deduplication preserved. Response satisfaction is
carried alongside response deliveries so the adapter can display objective
state.

## Adapter surface and activation (T3)

The adapter keeps `onclave_instances` and exposes one flat `onclave_message`
schema:

| Form | Required model fields | Behavior |
| --- | --- | --- |
| New request | `kind: "request"`, `to`, `body` | Asynchronous channel post. |
| New note | `kind: "note"`, `to`, `body` | Display-only channel post. |
| Active response | `body` | Adapter infers response kind, channel, request link, and destination. |
| Advanced response | `kind: "response"`, `channel_id`, `in_reply_to`, `body` | Explicit correlation outside an active request. |

`response_policy`, `schema`, and `channel_id` are optional advanced fields where
valid. Aliases are resolved against live registered full IDs before posting.
The model does not provide origin, sender identity, IDs, timestamps, sequence,
task IDs, trace IDs, or broker routing metadata. Validation rejects old task,
wait, and message-shape fields before publication.

Only a request naming the current instance as a responder triggers a Pi turn.
Other participants receive a display notification. Responses and notes are
inert display deliveries and do not trigger a turn or an automatic network
reply. Inbound bodies are framed as untrusted peer data. `CorrelationStore` is
session-owned context for active inbound requests, not a durable waiter or
outbound task ledger; reload clears it.

## Coupling removal (T4)

Automatic publication of arbitrary settled assistant text is removed. Channel
messages do not create or complete tasks, and no outbound channel call waits
for a peer, task result, timeout, or settled run. Independent task creation,
transitions, status events, vault notifications, and their existing tests remain
available through their separate APIs.

Audit, authentication, registration/liveness, provenance framing, delivery
leases, offline delivery, dead-letter behavior, and bounded message/status
deduplication remain in the implementation. Peer content never transfers
operator authority.

## Validation

Run from the module root:

```bash
pnpm run typecheck
pnpm test
pnpm exec vitest run packages/envelope/tests/a2a.test.ts packages/envelope/tests/amqp.test.ts packages/envelope/tests/protocol.test.ts services/core/tests/channel-store.test.ts services/core/tests/agent-delivery.test.ts extensions/onclave-pi/tests/communication.test.ts extensions/onclave-pi/tests/extension.test.ts extensions/onclave-pi/tests/http-client.test.ts extensions/onclave-pi/tests/dedup-summary.test.ts
pnpm exec vitest run --config vitest.integration.config.ts
```

The focused suites cover envelope rules, AMQP reconstruction, channel reuse and
sequence persistence, idempotency and satisfaction, fan-out/delivery leases,
alias and tool validation, request activation, inert response/note delivery,
HTTP parsing, deduplication, and removal of hidden settled-run publication.
Broker-backed commands require the repository's documented RabbitMQ test
prerequisite (`ONCLAVE_TEST_AMQP_URL` or `just test-integration`). Live
multi-instance Pi behavior and deployment cutover are outside offline
validation.
