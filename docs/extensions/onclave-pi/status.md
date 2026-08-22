---
created: 2026-07-18
status: active
source_prd: ./PRD.md
implementation_plan: ./implementation-plan.md
branch: feature/v2-broker-core
---

# Status: Onclave v2 Broker Core and Pi Adapter

## Current State

Phases 0 through 4 of the v2 implementation plan are complete on
`feature/v2-broker-core`. The repo is a pnpm workspace hosting the shared
envelope package, the containerized core service, and the supported Pi adapter.

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Workspace and compose stack | Complete | pnpm workspace extended with packages/* and services/*; rabbitmq + onclave-core compose stack with healthchecks; core skeleton with AMQP retry/backoff, idempotent topology declaration, /health; just targets up/down/logs/core-dev/test-integration; v1 suite stayed green through the conversion. |
| Phase 1: Shared envelope package | Complete | @onclave/envelope: versioned envelope schema, performatives, ULID, strict validation, AMQP property/header mapping with round-trip tests, hops, TTL parsing, reply builders, budget types (exchange hard stop, token advisory), provenance framing with receiver-generated boundaries, canonical JSON, and signed scoped delegation grants. |
| Phase 2: Core service | Complete | Registry persisted with the v1 atomic-write pattern, versioned RPC (register/heartbeat/unregister/list_agents/conversation_status/record_exchange), per-agent durable queues with DLX/TTL/length bounds, budget termination with failure to both parties, dead-letter consumer with advisory informs, JSONL audit with body-field rejection, trust scaffold. Integration suite runs against the compose test broker via just test-integration. |
| Phase 3: Pi adapter | Complete | extensions/onclave-pi: reconnect state machine, versioned register, validate-on-read consume with dedup, structurally inert inform (display-only, triggerTurn false), strict reply correlation by message id with no fallback, cross-host confirm with restart-free auto-accept, budget check before every turn delivery, tools (onclave_agents/send/delegate/inform/get/await), direct registered-agent delegation with request/audience/project/expiry binding, /onclave command, footer status. |
| Phase 4: Integration | Complete | Deterministic component and broker integration tests cover routing, delivery, correlation, budgets, and audit behavior. |
| Phase 5: CI and finalization | Complete on-branch | GitHub Actions workflow (typecheck, unit tests, integration tests against a rabbitmq service container, core image build), README v2 overview and quick start, decisions review below. The workflow commands and the image build were validated locally; a CI run on GitHub and the PR against main are left to the operator. |

## Verification

Last verified 2026-07-18 on a Windows 11 dev machine (Docker 29.6.1):

```bash
just check                                     # typecheck + 245 unit tests, green
just test-integration                          # 7 broker-backed integration tests, green
docker compose -f docker/compose.yaml up -d    # both containers healthy, /health ok
```

The deterministic suites cover request routing, strict correlation, inert
inform delivery, offline queue durability, exchange-budget termination, and
metadata-only audit records. Cross-host policy and TLS/per-adapter broker users
remain deferred hardening rather than deployment gates.

## Decisions Review

Decisions 6 through 10 in ./decisions.md were reviewed against the
implementation as built on 2026-07-18 and match: containerized core with
compose-owned lifecycle and versioned handshake (6), RabbitMQ durable
queues with DLX, native property mapping, validate-on-read, and persisted
conversation state (7), required performatives with code-path-inert inform
and budget termination (8), cross-host confirmation with restart-free
per-origin auto-accept (9), TypeScript core sharing the envelope package
with the adapter (10).

## Notes

- The retired v1 in-session LAN adapter has been removed.
- Sender adapters do not report exchanges; the receiving adapter calls
  `record_exchange` before any turn delivery, so each turn-triggering
  message is counted exactly once and the budget gate sits in front of
  delivery.
- Replies use the `inform` performative with `in_reply_to`, carrying run
  token usage in the envelope `usage` field.
