---
created: 2026-05-21
status: active
source_prd: ./onclave-comms-PRD.md
---

# Onclave v1 Decisions

This document records the remaining v1 product/architecture decisions for
`Onclave`.

## Decision 1: Hub Lifetime

**Decision:** Keep the v1 hub in-process inside the first Pi instance that wins
the local hub lock.

### Rationale

- The current implementation already avoids duplicate local hubs with
  `hub.json`, a health check, and `hub.lock`.
- The in-process model keeps v1 simple and avoids adding process supervisor,
  child-process lifecycle, log forwarding, and cross-platform signal-handling
  complexity.
- The hub state file allows later Pi instances to reuse the live hub and recover
  from stale state when the owning process exits or crashes.
- Moving to a detached child process is still compatible with the current
  `bootstrapLocalHub` boundary if longer-lived hub ownership becomes necessary.

### Consequences

- If the first Pi instance exits, the hub stops and subsequent Pi instances will
  start or discover a replacement on their next bootstrap.
- Local registrations are runtime state and are expected to refresh through Pi
  session startup.
- Manual acceptance must include closing the owning Pi instance and verifying a
  later instance recovers from stale hub state.

### Deferred Follow-up

A spawned hub process remains a post-v1 hardening option if operators need hub
lifetime independent from any Pi session.

## Decision 2: Static / Manual Peer Support

**Decision:** Include manual peer support in v1 through explicit remote tool
parameters and optional persistent static peers in `~/.pi/onclave/config.json`.

The supported v1 manual fallback is to call remote tools with either:

- `endpoint`, `node_id`, and `hub_instance_id`; or
- `peer_name` matching a configured static peer.

Existing tools using this model:

- `onclave_remote_agents`
- `onclave_remote_send`
- `onclave_remote_get`
- `onclave_static_peers`

### Rationale

- UDP discovery remains the default LAN discovery path.
- Explicit endpoint metadata provides a fallback when UDP broadcast is blocked
  by network policy or firewall configuration.
- Persistent static peers provide a practical fallback for LANs where UDP
  broadcast is blocked.
- Static peers are non-secret endpoint metadata only.
- Manual and static remote tools still require Ed25519 authorization through
  `authorized_keys`; endpoint knowledge alone does not grant list or message
  privileges.

### Consequences

- Operators can reach a known trusted peer even when UDP discovery is not
  available.
- Operators can either pass endpoint metadata directly or store repeated peer
  metadata in `config.json`.
- Static peer entries must use `wss://.../v1/hub` endpoints.
- Static peer trust is still enforced by `authorized_keys` during WSS auth.

### Deferred Follow-up

Automatic background polling/aggregation from static peers can be added later if
operators need static peers to appear alongside discovered trusted agent lists.
Richer static-peer convenience flows also remain a post-v1 operator UX item.

## Decision 3: Naming Policy

**Decision:** Lock naming into three layers for the current stage of the
project.

The naming policy is:

- `Onclave` is the overall product, factory vision, and repository identity.
- `onclave-comms` is the internal extension/package/directory name for the
  current communication subsystem.
- User-facing tool and command names remain on the existing `onclave_*` and
  `/onclave-*` surface for now.
- Runtime state paths remain under `~/.pi/onclave/` for now.

### Rationale

- The product now needs a broader name than the communication plugin alone.
- The repo and internal implementation need a more specific name for the comms
  subsystem so future factory components do not get mixed into a generic
  `onclave` plugin concept.
- Keeping the current user-facing command names avoids unnecessary operator
  churn and preserves the existing manual acceptance, usage, and test flows.
- Keeping `~/.pi/onclave/` avoids a second migration while the factory design is
  still settling.

### Consequences

- Internal paths, package names, and repo structure should prefer
  `onclave-comms` where they refer specifically to the communication subsystem.
- User docs may still say "run the Onclave tools" when referring to commands
  such as `onclave_status`, `onclave_peers`, and `onclave_remote_send`.
- A future rename of the tool surface or state root requires an explicit
  migration decision rather than happening incidentally during refactors.

### Deferred Follow-up

- Decide later whether the user-facing tools should stay on the `onclave_*`
  surface permanently or move to a factory-oriented surface with compatibility
  aliases.
- Decide later whether `~/.pi/onclave/` should remain the long-term state root
  or migrate to `~/.pi/onclave-comms/` with an explicit compatibility plan.

## Decision 4: Trust Import UX

**Decision:** Support both file-based trust changes and a validating append tool
for v1.

Current support:

- `/onclave-trust`
- `onclave_trust_info`
- `onclave_trust_add`
- local trust file: `~/.pi/onclave/authorized_keys`

### Rationale

- Manual file edits remain available for operators who prefer direct review.
- `onclave_trust_add` validates the line, rejects unsupported options/key
  types, dedupes existing keys, appends only public key lines, and audits
  metadata without private material.
- Sessions should be restarted after trust changes so active runtimes reload the
  trust file.

### Deferred Follow-up

A trust removal tool can be added later if operators need managed key revocation
without editing `authorized_keys`. Richer trust inspection UX also remains a
post-v1 operator improvement. A future trust request / approval workflow should
be planned against `./trust-ux-future.md`.

## Decision 5: WSS Transport Stack

**Decision:** Keep the v1 WSS implementation on Node `https` plus `ws` rather
than migrating to Bun-native `Bun.serve({ tls, websocket })` inside the Pi
extension runtime.

### Rationale

- Pi extensions run in the Node-based Pi host runtime, so the current Node
  transport integrates directly without a Bun-specific sidecar or process split.
- Manual two-host LAN acceptance passed with the current transport stack.
- The app-level Ed25519 mutual authentication remains the trust gate; transport
  encryption is still provided by self-signed TLS.
- The current transport tests and runtime behavior are stable enough for v1,
  while a Bun-native transport can remain a future optimization if Pi runtime
  constraints change.

### Consequences

- PRD and status docs should refer to the Node `https` plus `ws` transport as
  the accepted v1 implementation.
- Future transport changes should preserve the same frame protocol and mutual
  authentication behavior so operators do not need a workflow change.
- Reverse-direction acceptance helpers and higher-level orchestration remain
  operator UX work above the transport layer, not transport redesign tasks.

## Decision 6: Independent Containerized Core Service

**Status:** accepted 2026-07-17 (planning discussion) - see `./v2-PRD.md`
Workstream D; lands with branch `feature/v2-broker-core`.

**Decision:** Move the hub out of the first Pi session into an independent
core service running as a Docker container, deployed via Docker Compose
alongside RabbitMQ. Agent-specific adapters (Pi first) connect to it as
clients.

### Rationale

- Resolves Decision 1's deferred follow-up: hub lifetime becomes independent
  of any Pi session, so registrations and message state survive session
  churn.
- Docker restart policies own the lifecycle, eliminating the custom
  auto-start, single-instance election, and idle-exit machinery a per-user
  daemon would need. That per-user Go daemon design (go-winio pipes with
  user-scoped DACLs, bind-as-election, drain-and-exit upgrades) was fully
  researched and is recorded as a rejected alternative in the v2 PRD.
- An always-on core is the natural anchor for durable delivery, the registry,
  and later interop faces (MCP, Hermes bridge).
- Central-broker topology replaces hub-per-machine UDP discovery and
  hub-to-hub WSS; machines find the broker by address/DNS name (Joyride can
  publish it on the LAN). v1 stays frozen on `main` until the v2 adapter
  reaches parity, then retires; no wire compatibility is carried.

### Consequences

- The broker host becomes a single point of failure for agent comms; this is
  a conscious homelab trade recorded in the v2 PRD risks.
- The Pi extension becomes a thin adapter client with reconnect/backoff.
- Adapter/core handshakes carry a version field so mismatches fail loudly.

## Decision 7: RabbitMQ as the Delivery Substrate

**Status:** accepted 2026-07-17 (planning discussion) - see `./v2-PRD.md`
Workstream A.

**Decision:** Use RabbitMQ durable queues (one per agent) with a dead-letter
exchange for message delivery, replacing the v1 in-memory router. The
previously proposed maildir file store is superseded.

### Rationale

- v1 `MessageRouter` state dies with the hub process and cannot reach
  unregistered agents; broker-managed durable queues close both gaps with
  battle-tested store-and-forward, acks, and redelivery.
- At-least-once delivery with receiver-side dedup on message id is the
  correct guarantee for agents that restart; at-most-once drops messages in
  exactly that window.
- Per-queue TTL and length bounds with dead-lettering give bounded state and
  auditable expiry/overflow without custom sweep code.
- The envelope maps onto native AMQP properties (`message-id`,
  `correlation-id`, `expiration`, `reply-to`) with performative, hops,
  origin, and traceparent in headers.
- Validate-on-read at the adapter (reject without requeue, reply
  `not_understood`) prevents a malformed message from wedging a consumer.

### Consequences

- RabbitMQ becomes a deployment dependency (already running on the Docker
  host).
- Messages are inspectable via the management UI rather than as files.
- Conversation correlation state persists in the core's data volume so core
  restarts do not orphan pending responses.

## Decision 8: Performatives, Inert Inform, Conversation Budgets

**Status:** accepted 2026-07-17 (planning discussion) - see `./v2-PRD.md`
Workstream B.

**Decision:** Add a required enumerated `performative` field
(`request | inform | query | failure | not_understood`); make `inform`
structurally unable to trigger turns or tool calls; enforce per-conversation
exchange and token budgets in the router.

### Rationale

- Cross-agent prompt injection propagates epidemically, and provenance labels
  alone barely reduce attack success; the effective control is structural:
  only `request`/`query` may initiate a turn, and `inform` is inert by code
  path, not by prompt instruction.
- A message-class field lets the router rate-limit and gate without parsing
  free text (FIPA-ACL lesson).
- Hop counters bound forwarding but not ping-pong; budgets bound the
  conversation itself, which is the failure mode supervision cannot see.
- Sparse, scoped messaging is both cheaper and more robust than broad
  chatter.

### Consequences

- Envelope and frame schema change (versioned).
- Strict reply correlation replaces the latest-inbound fallback; unmatched
  runs submit nothing and audit the miss.
- Budget exhaustion ends conversations with `failure` to both sides.

## Decision 9: Cross-Host Request Confirmation and Reloadable Policy

**Status:** accepted 2026-07-17 (planning discussion) - see `./v2-PRD.md`
Workstream C. Amended from the earlier `local_only` proposal: with the
central-broker topology no listener runs on agent workstations, so a
loopback-only binding mode is moot; the surviving substance is origin-gated
confirmation and restart-free policy reloads.

**Decision:** Requests whose origin host differs from the receiving agent's
host require operator confirmation by default, with per-origin auto-accept as
explicit opt-in; policy configuration reloads without session restarts.

### Rationale

- Peer authentication proves sender identity, not content safety; a trusted
  peer that ingested poisoned content is a hostile sender with a valid badge,
  so cross-host instructions warrant a human gate by default.
- Scoping confirmation to cross-host origin keeps same-machine workflows
  frictionless and avoids rubber-stamp fatigue.
- v1 required session restarts after trust changes; policy that reloads live
  removes the operational friction recorded in the v1 status doc.

### Consequences

- Config schema gains per-origin policy fields owned by the core.
- Acceptance flows and the runbook need a confirmation step for cross-host
  requests.
- Transport authentication is broker credentials (per-adapter users on a
  dedicated vhost); TLS to the broker is the documented multi-machine
  hardening step.

## Decision 10: TypeScript Core Service

**Status:** accepted 2026-07-17 (planning discussion) - see
`./v2-implementation-plan.md`.

**Decision:** Implement the core service in TypeScript (Node 22), sharing an
envelope package (schema, validation, performatives, budget types) with the
Pi adapter.

### Rationale

- With RabbitMQ containerized, the per-user Go daemon rationale (pipe DACLs,
  auto-start, election, idle-exit) no longer applies; Docker owns the
  lifecycle.
- One language lets core and adapters consume the same envelope package,
  eliminating cross-language contract drift.
- Existing repo tooling (pnpm, vitest, tsc, just) carries over unchanged.

### Consequences

- Go remains open for a future component that independently earns it (for
  example a Joyride-integrated discovery sidecar).
- The repo converts to a pnpm workspace to host `packages/envelope`,
  `services/core`, and `extensions/onclave-pi` alongside the frozen v1
  extension.

## Decision 11: Scoped Operator Delegation Across Trusted Machines

**Status:** accepted 2026-07-19 (operator decision).

**Decision:** A direct operator confirmation may create a scoped, expiring
delegation for one registered target agent. A receiving adapter treats the
bounded request as delegated operator authorization only when its local policy
explicitly trusts the sender agent id for delegation and the audience, project,
conversation, request hash, and validity window match.

### Rationale

- Repeating the same approval in every trusted session prevents agents from
  completing an explicitly coordinated cross-machine workflow.
- The deployment is an operator-owned broker connecting trusted machines.
- Exact request binding plus direct review records bounded intent without
  making every ordinary peer message authoritative.

### Consequences

- `onclave_delegate` requires direct TUI interaction and is unavailable through
  RPC or ordinary `onclave_send`.
- Receivers opt in per sender through `delegatedAuthorityAgents` in the
  restart-free adapter policy.
- Grants are limited to 24 hours and bind the sender, target, project,
  conversation, exact body, action labels, and scope.
- The delegation is not a second sandbox or command-policy engine. Existing
  system, project, plan, backup, rollback, and safety constraints remain in
  force, and work outside the grant requires another delegation or direct
  approval.
