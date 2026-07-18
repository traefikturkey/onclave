---
created: 2026-07-18
status: active
source_prd: ./v2-PRD.md
implementation_plan: ./v2-implementation-plan.md
branch: feature/v2-broker-core
---

# Status: Onclave v2 Broker Core and Pi Adapter

## Current State

Phases 0 through 4 of the v2 implementation plan are complete on
`feature/v2-broker-core`. The repo is a pnpm workspace hosting the shared
envelope package, the containerized core service, and the v2 Pi adapter
alongside the untouched v1 extension.

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Workspace and compose stack | Complete | pnpm workspace extended with packages/* and services/*; rabbitmq + onclave-core compose stack with healthchecks; core skeleton with AMQP retry/backoff, idempotent topology declaration, /health; just targets up/down/logs/core-dev/test-integration; v1 suite stayed green through the conversion. |
| Phase 1: Shared envelope package | Complete | @onclave/envelope: versioned envelope schema, performatives, ULID, strict validation, AMQP property/header mapping with round-trip tests, hops, TTL parsing, reply builders, budget types (exchange hard stop, token advisory), provenance framing with receiver-generated boundaries, canonical-json ported from v1. |
| Phase 2: Core service | Complete | Registry persisted with the v1 atomic-write pattern, versioned RPC (register/heartbeat/unregister/list_agents/conversation_status/record_exchange), per-agent durable queues with DLX/TTL/length bounds, budget termination with failure to both parties, dead-letter consumer with advisory informs, JSONL audit with body-field rejection, trust scaffold. Integration suite runs against the compose test broker via just test-integration. |
| Phase 3: Pi adapter | Complete | extensions/onclave-pi: reconnect state machine, versioned register, validate-on-read consume with dedup, structurally inert inform (display-only, triggerTurn false), strict reply correlation by message id with no fallback, cross-host confirm with restart-free auto-accept policy, budget check before every turn delivery, tools (onclave_agents/send/inform/get/await), /onclave command, status widget. |
| Phase 4: Acceptance | Complete | scripts/onclave-v2-acceptance.ts drives the real adapter code through simulated Pi sessions against the real compose stack. Manual runbook in ./v2-manual-acceptance.md covers live-session, outage, and cross-host checks. |
| Phase 5: CI and finalization | Pending | Workflow, README, decisions confirmation. |

## Verification

Last verified 2026-07-18 on a Windows 11 dev machine (Docker 29.6.1):

```bash
just check                                     # typecheck + 245 unit tests, green
just test-integration                          # 7 broker-backed integration tests, green
docker compose -f docker/compose.yaml up -d    # both containers healthy, /health ok
pnpm exec tsx scripts/onclave-v2-acceptance.ts # 18/18 checks passed
```

Acceptance run summary (run id a3b0e7d0 and the follow-up full pass):

- compose stack healthy, core connected to broker
- request delivered with a turn, body inside boundary framing
- reply correlated strictly by message id, delivered as inert inform
- imperative inform delivered display-only, no turn produced
- two overlapping requests resolved to their own message ids
- message queued while the agent was offline arrived exactly once on restart
- scripted ping-pong halted at the 16-exchange budget (blocked at send 15)
  with inert failure envelopes to both parties
- core audit recorded registration, exchanges, and termination with no
  message bodies

Not covered by automation (see ./v2-manual-acceptance.md): live Pi turn
semantics, broker-outage widget behavior, cross-host confirmation and
restart-free policy reload (needs a second host), TLS/per-adapter broker
users (deferred hardening).

## Notes

- v1 (`extensions/onclave-comms`) is untouched and its suites still pass.
- Sender adapters do not report exchanges; the receiving adapter calls
  `record_exchange` before any turn delivery, so each turn-triggering
  message is counted exactly once and the budget gate sits in front of
  delivery.
- Replies use the `inform` performative with `in_reply_to`, carrying run
  token usage in the envelope `usage` field.
