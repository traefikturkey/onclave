---
created: 2026-07-17
status: draft
source_prd: ./v2-PRD.md
decisions: ./decisions.md
branch: feature/v2-broker-core
---

# Implementation Plan: Onclave v2 Broker Core and Pi Adapter

## Context

Onclave v1 is a single Pi extension (`extensions/onclave-comms`) hosting an
in-session hub. The v2 rework makes the core comms system an independent
service deployed as a Docker container alongside RabbitMQ, with agent-specific
adapter plugins. This plan covers the first two components: the core service
and the Pi adapter, built on branch `feature/v2-broker-core`.

A `rabbitmq` and an `onclave` container already run on the operator's Docker
host. This plan assumes the current `onclave` container is a placeholder and
produces the real image, compose definition, and local development flow.

## Constraints

- Repo: `traefikturkey/onclave`, currently a single-package TypeScript repo
  (pnpm, vitest, tsc, just). Windows Git Bash and Linux are both dev
  environments.
- v1 (`extensions/onclave-comms`) must keep passing its tests untouched on
  this branch until the v2 adapter reaches local-messaging parity. No v1 file
  edits except doc updates.
- RabbitMQ owns delivery (durable queues, acks, TTL, dead-lettering). The
  core service owns policy: registry, envelope validation, performatives,
  budgets, trust posture, audit.
- Reuse v1 library modules where they fit: `audit.ts`, `authorized-keys.ts`,
  `canonical-json.ts`, `state.ts`, `project-label.ts`.
- Structural guarantees (inert inform, budget enforcement, strict
  correlation) live in code paths, never in prompt text.
- No secrets in the repo: broker credentials come from env/compose `.env`
  (gitignored), with documented defaults for local dev only.

## Language Decision

Core service in **TypeScript (Node 22)**, not Go.

- With RabbitMQ containerized, the Go rationale from the daemon research
  (Windows named-pipe DACLs, client auto-start, single-instance election,
  idle-exit) no longer applies; Docker restart policies own the lifecycle.
- One language lets the envelope schema, validation, and budget logic live in
  a shared package consumed by both core and the Pi adapter, eliminating a
  cross-language contract drift risk.
- The repo's existing tooling (pnpm, vitest, tsc, just) carries over
  unchanged.

Go remains open for a future component where it earns its place (for example
a Joyride-integrated discovery sidecar). Recorded as Decision 10.

## Objective

A developer can run `docker compose up`, start two Pi sessions with the
`onclave-pi` adapter on the host, and have them exchange request/response and
inform messages through RabbitMQ with durable delivery, performative
enforcement, conversation budgets, strict reply correlation, and audit - with
`just check` green and an automated integration suite proving the flow.

## MVP Boundary

In scope: core service, Pi adapter, shared envelope package, compose stack,
integration tests, acceptance script, docs. Single broker host, single
machine's agents (multi-machine works transport-wise but is not acceptance-
tested in this plan).

Explicit deferrals:

- MCP face for Claude Code and the Hermes webhook bridge (next plan; the
  core's HTTP surface is scaffolded but only `/health` ships now).
- Joyride DNS publication and multi-machine TLS/auth hardening.
- Worktree leases.
- v1 extension retirement and migration tooling.
- Quorum queues / broker clustering (single-node classic durable queues).

## Architecture

```
+---------------------------- docker host ----------------------------+
|  rabbitmq:4-management            onclave-core (node:22-alpine)     |
|  - vhost "onclave"                - AMQP client of rabbitmq         |
|  - queue per agent                - registry + presence             |
|  - topic exchange (events)        - envelope validation + budgets   |
|  - DLX for expired/overflow      - trust store + audit JSONL       |
|  volumes: rabbitmq-data           - /health HTTP endpoint           |
|                                   volumes: onclave-data             |
+---------------------------------------------------------------------+
            ^ AMQP 5672 (LAN)                 ^
            |                                 |
   +--------+---------+             +---------+--------+
   | pi session A     |             | pi session B     |
   | onclave-pi       |             | onclave-pi       |
   | adapter (amqplib)|             | adapter (amqplib)|
   +------------------+             +------------------+
```

### RabbitMQ topology (declared idempotently by core on startup)

- vhost: `onclave`.
- Exchange `onclave.agents` (direct): routing key = `agent_id`; one durable
  queue `agent.<agent_id>` per registered agent, `x-dead-letter-exchange`
  set, per-queue `x-max-length` and message TTL from config.
- Exchange `onclave.events` (topic): `inform` broadcasts and presence
  heartbeats; adapters bind subscriptions by pattern (`presence.*`,
  `inform.<project>.*`).
- Exchange `onclave.dlx` (fanout) -> queue `onclave.dead-letter`: core
  consumes, audits expiry/overflow, emits advisory `inform`.
- Queue `onclave.core.rpc` (durable): registry and control operations
  (`register`, `heartbeat`, `unregister`, `list_agents`, `conversation_status`)
  as AMQP RPC with `reply-to`/`correlation-id`.

### Envelope mapping

AMQP properties: `message-id` = envelope id (ULID), `correlation-id` =
`conversation_id`, `expiration` = TTL, `reply-to` = sender queue.
Headers: `performative`, `hops`, `origin` (agent card subset: agent_id, name,
host, project), `in_reply_to`, `traceparent`. Body: JSON `{ body, schema? }`.
Shared package validates on both send and receive; malformed messages are
rejected at the adapter or dead-lettered by core with a `not_understood`
reply.

### Policy enforcement split

- Core (on `onclave.core.rpc` and via a message-tap consumer on DLX plus
  budget bookkeeping updates from adapters): registry truth, per-conversation
  exchange/token budgets, budget-exceeded termination (`failure` to both
  parties), audit of lifecycle/trust/advisories.
- Adapter (the only place with session access): delivery mode - `request`/
  `query` -> `sendMessage(..., { deliverAs: "followUp", triggerTurn: true })`
  with provenance framing; `inform` -> display-only, `triggerTurn: false`;
  strict `agent_end` correlation by message id (no latest-inbound fallback);
  remote-origin request confirmation via `ctx.ui.confirm` when
  `origin.host != local host`.

## Repo Layout Changes

Convert to a pnpm workspace; v1 stays where it is.

```
pnpm-workspace.yaml
packages/
  envelope/            # shared: schema, validation, performatives, budgets,
                       # ULID, provenance framing text builders
services/
  core/                # onclave-core service + Dockerfile
extensions/
  onclave-comms/       # v1, untouched
  onclave-pi/          # v2 Pi adapter extension
docker/
  compose.yaml         # rabbitmq + onclave-core
  compose.test.yaml    # ephemeral rabbitmq for integration tests
  .env.example
```

## Phases

### Phase 0: Branch scaffold and compose stack

Tasks:

1. Create `feature/v2-broker-core` branch (done; carries `v2-PRD.md` and
   proposed decisions).
2. Convert repo to pnpm workspace: root `pnpm-workspace.yaml`, move shared
   dev deps up, keep root `just check` running v1 suites plus new packages.
3. Add `docker/compose.yaml`: `rabbitmq:4-management` (volume, healthcheck on
   `rabbitmq-diagnostics ping`, management UI on 15672) and `onclave-core`
   service (build from `services/core/Dockerfile`, depends_on rabbitmq
   healthy, `/data` volume, `/health` port). `docker/.env.example` documents
   `RABBITMQ_DEFAULT_USER/PASS`, `ONCLAVE_AMQP_URL`.
4. `services/core` skeleton: connects to AMQP with retry/backoff, declares
   topology, serves `/health` (returns broker connectivity + declared
   topology), structured logs to stdout.
5. Justfile targets: `up`, `down`, `logs`, `core-dev` (tsx watch against
   compose rabbitmq), `test-integration`.

Validation gate: `docker compose -f docker/compose.yaml up -d` reaches
healthy on both containers; `/health` reports connected; `just check` still
green including untouched v1 tests.

### Phase 1: Shared envelope package

Tasks:

1. `packages/envelope`: envelope type, performative enum, AMQP property/
   header mapping helpers, ULID generation, validation (parse + classify +
   reject), provenance framing text builder, budget accounting types,
   `not_understood` reply builder.
2. Port `canonical-json.ts` and reuse patterns from v1 where applicable.
3. Unit tests: valid/invalid envelopes, header round-trip through AMQP
   property shapes, hop increment/cap, TTL parsing, adversarial bodies in
   `inform` (framing builder never emits instruction-voice text).

Validation gate: `pnpm --filter envelope test` green; package consumed by a
compile-only smoke import in core and adapter stubs.

### Phase 2: Core service

Tasks:

1. Registry: agent cards (agent_id, name, host, project, model,
   capabilities, heartbeat_at) persisted to `/data/registry.json` with the
   v1 atomic-write pattern; presence marked stale on missed heartbeats;
   `list_agents` RPC returns cards with liveness.
2. RPC handlers on `onclave.core.rpc`: register (declares/binds the agent
   queue), heartbeat, unregister, list_agents, conversation_status.
3. Budget bookkeeping: per `conversation_id` exchange count and token totals
   (adapters report usage in reply metadata); on breach, publish `failure`
   to both parties, mark conversation closed, audit.
4. Dead-letter consumer: audit expiry/overflow, emit advisory `inform` to
   the originating agent.
5. Trust/audit: port `audit.ts` JSONL with sensitive-field rejection to
   `/data/audit.jsonl`; trust file loading scaffolded (`/data/trust/`) but
   enforcement beyond AMQP auth deferred per PRD.
6. Config: env-driven (AMQP URL, TTLs, queue bounds, budget defaults).

Validation gate: vitest integration suite (compose.test.yaml rabbitmq)
covering register/heartbeat/list, queue declaration, DLX flow on TTL expiry,
and budget termination with two fake adapters driven over raw amqplib.

### Phase 3: Pi adapter extension

Tasks:

1. `extensions/onclave-pi`: session_start -> connect (amqplib), register
   with card built from session context (reuse `project-label.ts`),
   heartbeat timer with context/queue telemetry, session_shutdown ->
   unregister and close channel; connection loss -> reconnect with backoff,
   re-register, resume consuming (queued messages then deliver - durability
   demo).
2. Consume `agent.<agent_id>`: validate via envelope package; ack after
   successful hand-off; `request`/`query` -> provenance-framed
   `sendMessage` with `triggerTurn: true`; `inform` -> display-only
   message, no turn; malformed -> `not_understood` reply + reject (no
   requeue).
3. Strict reply capture: map in-flight inbound msg ids; `agent_end` matches
   by id only, publishes reply envelope (`in_reply_to`, same
   `conversation_id`, token usage metadata), audits and drops on no-match.
4. Tools and commands: `onclave_agents` (list via RPC), `onclave_send`
   (performative parameter, defaults `request`), `onclave_get` /
   `onclave_await` (correlation store fed by consumed replies),
   `onclave_inform` (explicit inert broadcast/point-to-point), `/onclave`
   status command; peer widget showing broker connectivity and live agents.
5. Remote-origin confirmation: `origin.host != os.hostname()` -> 
   `ctx.ui.confirm` before turn trigger; decline publishes `refuse`-style
   `failure` reply and audits.

Validation gate: adapter unit tests with a mocked channel (delivery modes,
correlation strictness, reconnect state machine); manual smoke via
`just pi-local-v2` (`pi -e ./extensions/onclave-pi`) against compose stack.

### Phase 4: End-to-end acceptance

Tasks:

1. Acceptance script (`scripts/onclave-v2-acceptance.ts`) mirroring the v1
   acceptance-host pattern: compose up, launch two headless Pi sessions with
   the adapter, then assert: A request -> B reply correlation; inform is
   inert (imperative body produces no turn); offline B receives queued
   message on restart (durability); scripted ping-pong halts at exchange
   budget with `failure` both sides; audit JSONL contains the expected
   events and no message bodies.
2. Concurrency case for strict correlation: two overlapping inbound
   requests to one session resolve to their own msg ids.
3. Document the runbook in `docs/extensions/onclave-comms/
   v2-manual-acceptance.md` including the Docker host deployment note
   (replacing the placeholder `onclave` container with the built image).

Validation gate: acceptance script passes on a dev machine against the
compose stack; run recorded in `status.md`-style notes on the branch.

### Phase 5: CI and branch finalization

Tasks:

1. GitHub Actions workflow: pnpm install, typecheck, unit tests, integration
   tests with a rabbitmq service container, core image build.
2. Update `README.md` (v2 overview + quick start). Decisions 6-10 are
   already recorded as accepted in `decisions.md`; confirm they still match
   the implementation as built.
3. Branch review pass: `just check`, full integration suite, acceptance
   evidence linked; open PR against `main`.

Validation gate: CI green on the PR; v1 suites still untouched and passing.

## Validation Commands

```bash
just setup && just check                       # repo-wide, includes v1
docker compose -f docker/compose.yaml up -d    # stack
just test-integration                          # core + adapter vs rabbitmq
pnpm exec tsx scripts/onclave-v2-acceptance.ts # end-to-end acceptance
```

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| amqplib reconnect edge cases in a TUI process | stuck consumers after network blips | reconnect state machine with tests; heartbeat gap detection; widget surfaces disconnected state |
| Workspace conversion breaks v1 tooling | v1 regression on the branch | phase 0 gate requires v1 suites green before any v2 code lands |
| Budget bookkeeping depends on adapter-reported tokens | inflated/missing usage skews budgets | treat exchange-count budget as the hard stop; token budget advisory until usage reporting is proven |
| Docker-host broker is a single point of failure | all agent comms down | out of scope by design (homelab trade recorded in PRD); compose restart policy; adapter degrades gracefully with clear status |
| Prompt-injection via inform bodies | instruction smuggling into context | inform is display-only by code path; framing builder tested against instruction-voice output; no relay |
| Credentials in compose | secret leakage | `.env` gitignored, `.env.example` only, per-adapter users documented for LAN hardening phase |

## Rollback

All work is additive on `feature/v2-broker-core`: new packages, new
extension directory, new docker directory. Rollback = do not merge; v1
extension and its tests are untouched. The Docker host placeholder container
can be reverted to its prior definition independently.
