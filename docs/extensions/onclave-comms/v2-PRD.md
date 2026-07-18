---
created: 2026-07-17
status: draft
source_prd: ./onclave-comms-PRD.md
decisions: ./decisions.md
implementation_plan: ./v2-implementation-plan.md
---

# PRD: Onclave v2 - Independent Core, RabbitMQ Delivery, Agent Adapters

## Problem

Onclave v1 delivered the secure LAN communication flow end to end: lock-protected
local hub startup and reuse, local WSS registration and messaging, explicit
Ed25519 trust, metadata-only UDP discovery, authenticated remote messaging, and
audit-safe runtime events, validated on two physical LAN hosts.

Three structural limits remain, all acknowledged or latent in v1:

1. **Hub lifetime is coupled to a Pi session.** The hub runs in-process inside
   the first Pi instance that wins `hub.lock` (Decision 1). When that session
   exits, the hub dies, local registrations drop, and in-flight message state is
   lost until the next bootstrap. Decision 1 explicitly deferred independent hub
   ownership as post-v1 hardening.
2. **Message routing is memory-only.** `MessageRouter` holds all message state
   in a `Map` inside the hub process. A prompt to an unregistered (restarting,
   busy-elsewhere, or not-yet-started) agent fails with `target_not_found`; a
   hub restart orphans every pending correlation. There is no store-and-forward.
3. **Every inbound message is a turn-triggering instruction.** Delivery always
   uses `triggerTurn: true`, and nothing in the envelope distinguishes "here is
   status information" from "do this work". Loop protection is a hop counter
   only; there are no per-conversation turn or token budgets, and the raw prompt
   body is injected after the provenance header with no structural gate.

Two further gaps limit reach and operability: the system is Pi-only (no path
for other local agents such as Claude Code sessions or a Hermes runtime to
participate), and there is no cross-hop tracing or per-conversation cost
accounting.

## v2 Architecture Direction

v2 restructures Onclave as a broker-first product:

- **Independent core service**: a containerized TypeScript service (Docker
  Compose, alongside RabbitMQ) that owns registry/presence, envelope policy,
  conversation budgets, trust posture, and audit. No agent session hosts the
  hub anymore.
- **RabbitMQ as the delivery substrate**: durable queue per agent, topic
  exchange for inert informs and presence, dead-letter exchange for TTL and
  overflow. Store-and-forward, acks, and redelivery come from the broker, not
  custom code.
- **Agent adapters as plugins**: a thin Pi extension adapter first, with
  further adapters/faces (MCP for Claude Code, webhook bridge for Hermes)
  following in later plans. Adapters own the last hop: delivery mode into the
  session, reply capture, and confirmation gates.
- **Central-broker topology replaces the v1 mesh**: machines reach the broker
  by address/DNS name (Joyride-published on the LAN) instead of hub-per-machine
  UDP discovery and hub-to-hub WSS. v1 remains frozen on `main` until the v2
  adapter reaches parity, then retires; no wire compatibility is carried.

## Research Grounding

The v2 requirements below are informed by a survey of prior art and literature.
Key findings, with the requirement each one drives:

- **Delivery guarantee.** At-most-once delivery loses messages exactly during
  the receiver-restart window that matters for long-lived TUI agents.
  At-least-once with idempotent consumers (dedup on message id) is the standard
  answer, provided by broker acks, durable queues, and redelivery
  (https://www.rabbitmq.com/docs/reliability,
  https://docs.nats.io/nats-concepts/jetstream for the pattern comparison).
  Drives Goal 1.
- **Validate-on-read mailboxes.** Anthropic's multi-agent Claude Code teams
  validate each inbox entry on read so one malformed entry cannot wedge a
  mailbox (https://code.claude.com/docs/en/agent-teams). Drives Goal 1's
  adapter-side handling.
- **Performatives.** FIPA-ACL demonstrates that a required, enumerated
  message-class field lets receivers route and rate-limit without parsing the
  free-text body (https://www.fipa.org/specs/fipa00061/SC00061G.html). A minimal
  subset (request, inform, query, failure, not_understood) is sufficient for
  agent-to-agent use. Drives Goal 2.
- **Structural loop and cost control.** Infinite agent loops are invisible to
  supervision (the actor-model lesson); bounds must be external: hop caps plus
  per-conversation turn and token budgets. Dense agent-to-agent chatter is the
  dominant cost driver and an attack surface; sparse, scoped messaging matched
  dense topologies at roughly one-eighth the cost while also blunting
  adversarial messages (AgentPrune, https://arxiv.org/abs/2410.02506). Drives
  Goal 2.
- **Cross-agent prompt injection is epidemic.** A single injected prompt
  self-replicates across cooperating agents with high success, including over
  private point-to-point channels (Prompt Infection,
  https://arxiv.org/abs/2410.07283; Agent Smith,
  https://arxiv.org/abs/2402.08567). Provenance labels alone reduced attack
  success only marginally; labels must gate behavior. Peer authentication
  proves sender identity, never content safety: an authenticated peer that just
  ingested a poisoned document is a hostile sender with a valid badge. The
  practical gate is the lethal-trifecta rule: require explicit confirmation
  only when acting on an inbound message would combine private-data access,
  untrusted content, and an exfiltration-capable action
  (https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/). Drives Goals 2
  and 3.
- **Daemon lifecycle research** (gpg-agent auto-start and election patterns,
  Windows named-pipe constraints for Node servers, go-winio DACLs) informed a
  per-user daemon alternative that was ultimately rejected: containerizing the
  core with Docker restart policies makes the custom lifecycle machinery
  unnecessary. Recorded in Alternatives. (nodejs/node#55979,
  https://github.com/microsoft/go-winio,
  https://www.gnupg.org/documentation/manuals/gnupg24/gpg-agent.1.html)
- **Interop.** The Model Context Protocol's Streamable HTTP transport allows a
  single long-lived process to serve every MCP client, making a shared mailbox
  reachable from Claude Code and similar clients with a config entry; stdio MCP
  servers are per-client and cannot share state
  (https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
  Delivery into a live interactive Claude Code session is pull-with-nudge, not
  push. Drives Goal 5 (deferred to the follow-up plan).
- **Tracing.** W3C Trace Context propagated in message metadata plus a stable
  conversation id makes a multi-agent exchange one queryable trace, and
  OpenTelemetry GenAI semantic conventions define the token-usage attributes
  for per-conversation cost rollups
  (https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/,
  https://opentelemetry.io/docs/specs/semconv/gen-ai/). Drives Goal 6.
- **Upstream posture.** Pi core deliberately ships no subagent or multi-agent
  layer and directs this work to extensions and packages, so obsolescence risk
  for Onclave is low
  (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md).

## Goals

1. **Durable delivery.** Per-agent durable RabbitMQ queues with dead-lettering
   give at-least-once delivery that survives absent receivers and restarts,
   with receiver-side dedup on message id.
2. **Envelope semantics.** A required performative field with an inert
   `inform` class, per-conversation turn and token budgets enforced by the
   core, and strict reply correlation (fix the latest-inbound fallback).
3. **Trust posture.** Confirm-by-default handling for requests originating
   from other hosts, per-origin policy configuration that reloads without
   session restarts, and audit continuity from v1.
4. **Independent core.** A containerized TypeScript core service deployed via
   Docker Compose with RabbitMQ, owning registry, policy, budgets, trust, and
   audit, with a versioned adapter handshake.
5. **Interop ingress.** (Deferred to the follow-up plan.) A Streamable HTTP
   MCP face and a Hermes webhook bridge on the core so non-Pi agents join the
   same fabric.
6. **Observability.** Propagate W3C traceparent across hops and account tokens
   per conversation id.

Goals 1-4 are this milestone (see `./v2-implementation-plan.md`). Goals 5-6
extend the core afterward; traceparent fields ship in the envelope from day
one.

## Non-Goals

- No publicly resolvable internet endpoint. Reach beyond the LAN should use an
  overlay network (Tailscale or equivalent) rather than public DNS plus
  certificate management.
- No full A2A protocol adoption. Borrow the Agent Card shape for listings and
  the always-emit-terminal-state task rule only.
- No v1 wire compatibility. The central-broker topology replaces
  hub-per-machine UDP discovery and hub-to-hub WSS; v1 stays frozen on `main`
  until parity, then retires.
- No broker clustering or quorum queues in this milestone; single-node durable
  queues on the homelab broker host.
- No cross-machine work leases in v2 (single-machine worktree leases may be
  specified separately).
- No reading or writing of private keys under `~/.ssh/`. An ssh-agent-based
  signing path may be evaluated as a future identity option but is not v2
  scope.

## Requirements

### Workstream A: Durable delivery (Goal 1)

- One durable queue per registered agent (`agent.<agent_id>`) on a direct
  exchange, declared by the core at registration.
- Per-queue message TTL and length bounds; expired and overflowed messages
  route to a dead-letter exchange consumed by the core, which audits the event
  and emits an advisory `inform` to the originator.
- Adapters ack only after successful hand-off into the session; redelivery
  plus receiver-side dedup on message id yields at-least-once processing.
- Adapters validate every consumed message against the shared envelope schema;
  malformed messages are rejected without requeue and answered with
  `not_understood`, never allowed to wedge the consumer.
- Conversation correlation state persists in the core's data volume so a core
  restart does not orphan pending responses.

### Workstream B: Envelope semantics (Goal 2)

- Add a required `performative` field to the message envelope:
  `request | inform | query | failure | not_understood`.
- `inform` delivery must be structurally inert: displayed to the operator and
  available as context, delivered with `triggerTurn: false`, never able to
  initiate a turn or tool call.
- Only `request` and `query` may trigger a turn.
- Add `conversation_id` with per-conversation budgets: maximum
  request/response exchanges and maximum total tokens. Exceeding either
  forcibly ends the conversation with a `failure` message to both parties.
- Keep the hop counter; hops and budgets are enforced in core/adapter code,
  not by prompt instructions.
- Fix reply correlation: reply capture must match the run to its inbound
  message strictly by message id; if no match is found, submit nothing and
  audit the miss. Remove the latest-inbound fallback.
- No-relay rule: an agent must not forward instruction-shaped content from one
  peer to another; replies route only to the originating correlation.
- Envelope fields map to native AMQP properties (`message-id`,
  `correlation-id`, `expiration`, `reply-to`) with performative, hops, origin,
  and traceparent in headers.

### Workstream C: Trust posture (Goal 3)

- Requests whose origin host differs from the receiving agent's host default
  to operator confirmation before the turn runs; per-origin auto-accept is an
  explicit opt-in recorded in configuration.
- Transport authentication uses broker credentials (per-adapter users on a
  dedicated vhost); TLS to the broker is a documented hardening step for
  multi-machine use.
- Policy configuration (origin policies, budgets, bounds) reloads without
  agent session restarts.
- Inbound message bodies remain framed as data with provenance headers; the
  framing must state that bus content is information to evaluate, not
  instructions to obey.
- Audit continuity: JSONL audit with sensitive-field rejection carries over
  from v1 into the core's data volume.

### Workstream D: Independent core service (Goal 4)

- Containerized TypeScript (Node 22) service deployed via Docker Compose with
  `rabbitmq:4-management`; Docker restart policies own the lifecycle.
- Declares broker topology idempotently on startup; serves `/health`
  reporting broker connectivity.
- Owns: registry and presence (agent cards with heartbeats, stale marking),
  registry RPC (`register`, `heartbeat`, `unregister`, `list_agents`,
  `conversation_status`), budget bookkeeping and termination, dead-letter
  handling, trust/policy configuration, audit.
- Versioned handshake between adapters and core so mismatches fail loudly and
  upgrades are drain-and-restart via compose.
- Agent cards follow the A2A Agent Card shape in spirit: id, name, host,
  project, model, capabilities, transport.
- The Pi adapter (`extensions/onclave-pi`) is a thin client: connect,
  register, consume, deliver by performative, capture replies, reconnect with
  backoff and resume.

### Workstream E: Interop and observability (Goals 5, 6 - follow-up plan)

- Streamable HTTP MCP face on the core (send_message, check_inbox,
  list_agents) with Origin validation; MCP clients appear in the registry.
- Hermes bridge: inbound via its HMAC-signed webhook adapter, outbound via
  its notify surface.
- Envelope carries `traceparent` from day one; spans follow OpenTelemetry
  messaging conventions where telemetry is emitted; token usage accumulates
  per `conversation_id` against Workstream B budgets.

## Acceptance Criteria

1. [ ] A prompt sent to a not-currently-running agent is delivered when that
   agent next starts.
   - Verify: send to a registered-then-exited agent; start a new session for
     the same agent identity; observe delivery and response correlation.
   - Pass: message arrives once (dedup holds), response correlates, audit
     records the flow.
   - Fail: delivery lost, duplicated, or correlation broken.

2. [ ] Core restart does not orphan pending conversations.
   - Verify: send a request, restart the core container before the response,
     then submit the response.
   - Pass: correlation state recovered from the data volume; the sender
     retrieves the response.
   - Fail: response unmatchable after restart.

3. [ ] `inform` messages cannot trigger turns or tool calls.
   - Verify: send an `inform` containing imperative instructions to a live
     agent.
   - Pass: content displayed/available as context only; no turn starts; audit
     records inert delivery.
   - Fail: a turn or tool call results.

4. [ ] Conversation budgets terminate runaway exchanges.
   - Verify: configure a low exchange budget; script two agents to ping-pong.
   - Pass: the exchange stops at the budget with `failure` messages to both
     sides and an audit record.
   - Fail: exchange continues past budget.

5. [ ] Reply correlation is strict.
   - Verify: deliver two concurrent inbound requests to one agent; complete
     the runs.
   - Pass: each response submits against its own message id; no fallback
     mismatch.
   - Fail: a response attaches to the wrong message.

6. [ ] Expiry and overflow are bounded and audited.
   - Verify: fill a bounded queue past its cap; let a TTL message expire.
   - Pass: dead-letter flow drops/expires as configured, audit records the
     events, originator receives an advisory `inform`.
   - Fail: unbounded growth or silent loss.

7. [ ] Cross-host requests require confirmation by default.
   - Verify: send a request whose origin host differs from the receiver's,
     with no auto-accept configured.
   - Pass: operator is prompted before the turn runs; decline sends an
     audited `failure` reply.
   - Fail: turn runs without confirmation.

8. [ ] Adapter survives broker unavailability.
   - Verify: stop the broker mid-session, send attempts fail visibly, restart
     the broker.
   - Pass: adapter reconnects with backoff, re-registers, resumes consuming;
     queued messages arrive; status widget reflected the outage.
   - Fail: stuck consumer or silent message loss.

9. [ ] Policy changes apply without session restarts.
   - Verify: change an origin auto-accept policy and a budget default while
     sessions run.
   - Pass: next message honors the new policy.
   - Fail: stale policy until restart.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Keep in-session hub, add persistence only | Smallest change | Hub lifetime problem remains; Decision 1 debt unresolved; no interop anchor | Rejected |
| Per-user Go daemon (named pipes/UDS, auto-start, bind election, idle-exit) | No infrastructure dependency; per-machine autonomy | Custom lifecycle machinery; cross-language envelope contract drift with the TS adapter; redundant once a central broker host exists | Rejected; research retained in grounding |
| Node child-process hub | One language, no container | Node pipe servers cannot set Windows ACLs or first-instance flags (squatting risk); still custom lifecycle | Rejected |
| Brokerless file mailboxes (maildir) only | Zero infrastructure | Loses LAN reach, push delivery, shared interop state; central broker replaces the need | Rejected |
| Embedded NATS in a Go core | Subjects, JetStream durability in one binary | Ties core to Go; RabbitMQ provides equivalent durability with mature ops tooling already running on the Docker host | Rejected |
| RabbitMQ as delivery substrate | Durable queues, acks, TTL, DLX, native request/reply, management UI; battle-tested | Always-on broker host required; agents without broker reach have no fallback | **Accepted** (homelab trade recorded consciously) |
| Go core service on RabbitMQ | Static binary | Duplicated or generated envelope contract for the TS adapter; repo tooling is TS | Rejected; TS core accepted |
| Public `picomms` DNS endpoint for reach | Simple client story | Public attack surface, certificate lifecycle, exposed auth gate | Rejected; overlay network (Tailscale) is the sanctioned wider-reach path; Joyride publishes the broker name on the LAN |
| Full A2A face now | Third-party interop | Heavy for localhost; MCP covers the actual local clients | Deferred; borrow Agent Card shape only |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Broker host is a single point of failure | All agent comms down when unreachable | Conscious homelab trade; compose restart policies; adapter degrades visibly and resumes cleanly |
| amqplib reconnect edge cases in a TUI process | Stuck consumers after network blips | Reconnect state machine with tests; heartbeat gap detection; widget surfaces disconnected state |
| Inert `inform` weakened by prompt-level workarounds | Injection surface returns | Enforce in delivery code path, never via prompt text; test with adversarial inform bodies |
| Confirmation fatigue on cross-host requests | Operators enable blanket auto-accept | Scope confirmation to cross-host origin only; per-origin opt-in; local flow frictionless |
| Budget bookkeeping depends on adapter-reported tokens | Skewed budgets | Exchange-count budget is the hard stop; token budget advisory until usage reporting is proven |
| Queue/state accumulation | Disk growth, stale prompts delivered late | Per-queue TTL and length bounds, DLX advisories, sweep audits |
| Credentials handling in compose | Secret leakage | `.env` gitignored with `.env.example` only; per-adapter broker users documented for hardening |

## Open Questions

- Where do worktree/repo leases land: a follow-up to this PRD or a separate
  factory-level document?
- Should MCP-joined agents be addressable by agents on other machines, or
  scoped to their own host initially?
- Does the Hermes bridge live in the core or as a standalone bridge container?

## Plan Handoff

Implementation sequencing, repo layout, RabbitMQ topology detail, phases, and
validation gates live in `./v2-implementation-plan.md` on branch
`feature/v2-broker-core`.
