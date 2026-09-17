---
created: 2026-09-15
status: implementation-pending-acceptance
source_prd: ./PRD.md
branch: task/asynchronous-channel-messaging
---

# Status: Onclave Asynchronous Channels

## Current state

The worktree contains the coordinated v2 channel envelope, core channel
aggregate and fan-out path, Pi adapter, independent task primitives, focused
tests, and aligned documentation. Changes remain uncommitted and are not
deployed or merged into another checkout.

## Delivered channel behavior

- `ChannelMessage` uses protocol version 3 and semantic kinds `request`,
  `response`, `note`, and service-only `notification`.
- The core creates or reuses an open channel for the exact normalized
  participant set, assigns channel/message IDs and monotonic sequence numbers,
  persists before acknowledgement, and restores bounded state on restart.
- Requests name response recipients. One recipient defaults to `all`; a group
  defaults to `any`; a group may explicitly require `all`.
- Responses link to a known request. Named responders count once, and objective
  `open`/`satisfied` state is persisted. Unexpected or repeated responses stay
  in history without satisfying the request. Notifications carry no response
  expectation and create no request-satisfaction state.
- Full instance IDs remain routing identities. The adapter resolves short
  aliases before publication. RabbitMQ continues using durable
  `agent.<full-instance-id>` mailboxes and application-owned fan-out rather
  than channel exchanges.
- Delivery remains at-least-once. Existing signed HTTPS authentication,
  leases, dead-letter handling, offline retention, bounded deduplication, audit,
  and untrusted-peer framing remain in use.

## Adapter behavior

Only `onclave_instances` and `onclave_message` are model-facing. New requests
and notes use `kind`, `to`, and `body`. During an active inbound request turn,
a response uses only `body`; the adapter supplies response kind, channel,
request link, and destination. Explicit response correlation is an advanced
outside-turn path.

Only named request responders receive a turn trigger. Other participants,
responses, notes, and independent task-status events are display-only. Trusted
Onclave services may publish terminal `notification` messages; each notification
is delivered as one untrusted, one-way follow-up turn, never registers inbound
correlation, and expects no `onclave_message` response. Completed delivery is
message-ID deduplicated. There is no synchronous outbound wait, automatic
response loop, or automatic publication of settled assistant text. The
session-owned correlation store is only active inbound-request context and is
cleared on reload/shutdown.

## Independent task boundary

Task and task-status APIs remain separately versioned and compilable. Channel
messages do not create, complete, cancel, or resume tasks. Existing task states,
transitions, terminal immutability, usage, audit, and vault notification seams
remain independent of request satisfaction.

## Validation state

A focused notification/protocol offline run passed 6 test files and 55 tests,
together with `pnpm run typecheck`. The focused suites cover envelope and
protocol validation, vault terminal publication, notification delivery without
correlation, adapter activation and deduplication, and framing. The broader
offline unit run and broker-backed integration remain separate acceptance
checks; broker integration requires the documented RabbitMQ prerequisite. No
live multi-instance Pi behavior, deployment, or broker cutover is claimed.

Run the bounded checks from the module root with:

```bash
pnpm run typecheck
pnpm test
pnpm exec vitest run --config vitest.integration.config.ts
```

## Protocol and deployment status

Protocol v3 is an explicit incompatible boundary. Core and adapters must be
upgraded together; mismatched live versions are rejected and no translation
layer is provided. Valid persisted v2 channel state is migrated without history
loss. No live deployment or broker cutover has occurred. The implementation
branch is `task/asynchronous-channel-messaging`; integration and commit status
are intentionally pending the authorized closeout workflow.
