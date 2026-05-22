---
created: 2026-05-21
status: active
source_prd: ./PRD.md
---

# COMS LAN v1 Decisions

This document records the remaining v1 product/architecture decisions for
`coms-lan`.

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
parameters and optional persistent static peers in `~/.pi/coms-lan/config.json`.

The supported v1 manual fallback is to call remote tools with either:

- `endpoint`, `node_id`, and `hub_instance_id`; or
- `peer_name` matching a configured static peer.

Existing tools using this model:

- `coms_lan_remote_agents`
- `coms_lan_remote_send`
- `coms_lan_remote_get`
- `coms_lan_static_peers`

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

## Decision 3: Trust Import UX

**Decision:** Support both file-based trust changes and a validating append tool
for v1.

Current support:

- `/coms-lan-trust`
- `coms_lan_trust_info`
- `coms_lan_trust_add`
- local trust file: `~/.pi/coms-lan/authorized_keys`

### Rationale

- Manual file edits remain available for operators who prefer direct review.
- `coms_lan_trust_add` validates the line, rejects unsupported options/key
  types, dedupes existing keys, appends only public key lines, and audits
  metadata without private material.
- Sessions should be restarted after trust changes so active runtimes reload the
  trust file.

### Deferred Follow-up

A trust removal tool can be added later if operators need managed key revocation
without editing `authorized_keys`. Richer trust inspection UX also remains a
post-v1 operator improvement.

## Decision 4: WSS Transport Stack

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
