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
parameters, not through persistent static peer configuration.

The supported v1 manual fallback is to call remote tools with:

- `endpoint`
- `node_id`
- `hub_instance_id`

Existing tools using this model:

- `coms_lan_remote_agents`
- `coms_lan_remote_send`
- `coms_lan_remote_get`

### Rationale

- UDP discovery remains the default LAN discovery path.
- Explicit endpoint metadata provides a fallback when UDP broadcast is blocked
  by network policy or firewall configuration.
- Avoiding persistent static peer config keeps v1 smaller and reduces ambiguity
  around stale endpoints, trust state synchronization, and config migration.
- Manual remote tools still require Ed25519 authorization through
  `authorized_keys`; endpoint knowledge alone does not grant list or message
  privileges.

### Consequences

- Operators can reach a known trusted peer even when UDP discovery is not
  available.
- Operators must provide the remote endpoint and IDs manually for remote tools.
- Automatic aggregation from static configured peers is deferred.

### Deferred Follow-up

A future `config.json` static peer list can be added under `~/.pi/coms-lan/` if
manual parameter entry becomes too repetitive.

## Decision 3: Trust Import UX

**Decision:** Keep trust changes file-based for v1, with a trust information
command/tool to show the local public key line and `authorized_keys` path.

Current support:

- `/coms-lan-trust`
- `coms_lan_trust_info`
- local trust file: `~/.pi/coms-lan/authorized_keys`

### Rationale

- Manual file edits keep trust changes explicit and auditable.
- The narrow `ssh-ed25519` parser rejects unsupported options and key types.
- Avoiding automatic append/import commands reduces the chance of accidentally
  trusting the wrong peer during v1 validation.

### Deferred Follow-up

A future `coms_lan_trust_add` tool may validate, dedupe, append, and audit a
public key line after the manual LAN workflow has been validated.
