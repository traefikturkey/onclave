---
created: 2026-05-21
status: active
source_prd: ./PRD.md
---

# Implementation Plan: Secure LAN Pi Agent Communication

## Scope

Build a separate `onclave.ts` Pi extension/system that provides secure LAN
hub discovery, explicit hub authorization, local Pi instance registration, and
trusted prompt/response messaging.

This plan is intentionally scoped to the PRD v1 goals:

- One hub per machine.
- Multiple local Pi instances registered to the local hub.
- UDP LAN hub discovery with no sensitive payload fields.
- Direct hub-to-hub `wss://` transport after discovery.
- Ed25519 challenge-response authentication before any remote agent listing or
  messaging.
- Persistent state, config, runtime files, and audit logs under
  `~/.pi/onclave/`.
- No changes to `coms.ts` or `coms-net.ts` as the primary implementation path.

## Prior-Art Review

### Joyride Docker Cluster

Relevant files reviewed:

- `plugins/docker-cluster/discovery.go`
- `plugins/docker-cluster/cluster.go`
- `plugins/docker-cluster/cluster_config.go`

Design lessons to reuse:

- Keep UDP discovery packets small and metadata-only.
- Use a magic/protocol marker to ignore unrelated UDP packets.
- Broadcast immediately at startup, then on a fixed interval.
- Ignore self-discovery by persistent node ID.
- Derive the peer endpoint from sender IP plus advertised service port.
- Run broadcast and listen loops under a cancellable lifecycle.
- Keep discovery separate from authenticated transport and higher-level
  messaging.

Differences required by this PRD:

- Joyride uses discovery as a join helper for a memberlist cluster; `Onclave`
  must not join or trust discovered peers automatically.
- Joyride discovery stores peers by node ID to endpoint only; `Onclave` also
  needs trust state, auth state, last-seen timestamps, runtime instance IDs,
  protocol version, and audit events.
- Joyride uses a fixed default discovery port. `Onclave` may use a default UDP
  discovery port, but the local hub service port must be dynamically selected
  and published in hub state.
- Joyride does not perform app-level public-key authentication. `Onclave` must
  require Ed25519 challenge-response before remote listing or messaging.

### Pi `coms` and `coms-net`

Relevant files reviewed:

- `extensions/coms.ts`
- `extensions/coms-net.ts`
- `scripts/coms-net-server.ts`

Design lessons to reuse:

- Tool surface shape: list, send, get, await.
- Message status model: queued, delivered, complete, error, timeout.
- Response correlation by message ID.
- Inbound prompt handling through `pi.sendMessage`, then response submission from
  the next `agent_end` event.
- Heartbeat/stale/offline cleanup for registered local instances.
- Server state files that publish a local endpoint without exposing tokens or
  sensitive data.
- Best-effort audit entries for lifecycle, registration, message, and failure
  events.
- Explicit warnings in tool descriptions to avoid reply loops.

Differences required by this PRD:

- `coms` is same-machine peer-to-peer. `Onclave` needs a machine-level hub.
- `coms-net` uses bearer-token HTTP/SSE to a configured hub. `Onclave` needs
  hub discovery, local hub bootstrap, `wss://`, and Ed25519 hub auth.
- Existing agent cards include raw `cwd`; `Onclave` should avoid exposing raw
  local paths across discovery and should prefer safe project labels in remote
  views.
- Existing networked comms trusts a configured server. `Onclave` must show
  unknown discovered hubs as untrusted and block listing/messaging.

## Proposed Repository Shape

The current repository contains only documentation. Implementation should add the
minimal runtime and test scaffolding needed for a Pi extension:

```text
extensions/
  onclave.ts
scripts/
  onclave-hub.ts         # only if the hub cannot safely live inside extension code
src/onclave/
  audit.ts
  authorized-keys.ts
  canonical-json.ts
  crypto.ts
  discovery.ts
  hub.ts
  local-hub.ts
  messages.ts
  project-label.ts
  state.ts
  transport.ts
tests/
  onclave/
    authorized-keys.test.ts
    canonical-json.test.ts
    discovery.test.ts
    handshake.test.ts
    local-hub.test.ts
    messages.test.ts
    project-label.test.ts
```

Planning bias: start with `extensions/pi-onclave` plus small `packages/core/src/onclave/*`
modules. Add `scripts/onclave-hub.ts` only if process lifecycle or Bun server
startup is cleaner outside the extension.

## Runtime State Layout

All files live under `~/.pi/onclave/`:

```text
~/.pi/onclave/
  authorized_keys              # imported/configured ssh-ed25519 public keys
  audit.log.jsonl              # append-only JSONL audit events
  config.json                  # non-secret operator config
  hub.json                     # current local hub endpoint/state
  hub.lock                     # startup race guard
  identity.json                # persistent local node/hub ID and public key
  identity.key                 # app-specific private signing key; not ~/.ssh
  runtime/
    <hub_instance_id>.json     # live runtime metadata
```

Security rules:

- Never read, write, or modify private keys under `~/.ssh/`.
- Discovery packets must not include prompts, private keys, auth tokens, raw cwd,
  or sensitive local paths.
- Audit logs must avoid prompt body storage by default. Log message IDs,
  directions, local/remote node IDs, agent labels, status, and error reasons.
- Private key files should be created with restrictive permissions where the
  platform supports them.

## Core Data Model

### Persistent identity

- `node_id`: generated stable ID for the machine hub.
- `public_key`: app-specific Ed25519 public key.
- `private_key_path`: points to `identity.key` under `~/.pi/onclave/`.
- `created_at` and `version`.

### Runtime identity

- `hub_instance_id`: generated on hub start.
- `pi_instance_id`: generated per Pi process.
- `session_id`: Pi session ID or generated equivalent.

### Discovery packet

Metadata-only JSON packet:

```json
{
  "m": "PI-ONCLAVE",
  "v": 1,
  "node_id": "...",
  "hub_instance_id": "...",
  "wss_port": 0,
  "started_at": "..."
}
```

Receiver derives the host from the UDP sender address and combines it with
`wss_port`. The packet intentionally excludes keys, prompts, cwd, agent lists,
and authorization state.

### Peer state

- `node_id`
- `hub_instance_id`
- `endpoint`
- `last_seen_at`
- `trust_state`: `untrusted | trusted | auth_failed | stale`
- `auth_state`: `not_attempted | in_progress | authenticated | failed`
- `authorized_key_fingerprint` when authenticated

## Authentication Design

Use app-level Ed25519 signatures over a deterministic canonical JSON payload.
The TLS certificate is self-signed and provides encrypted transport; hub trust is
based on the Ed25519 key authorization result, not on a CA chain.

Handshake outline:

1. Client opens `wss://host:port/v1/hub`.
2. Server sends `server_hello` with protocol version, server node ID, server hub
   instance ID, endpoint, fresh server nonce, and freshness timestamp.
3. Client sends `client_auth` with client node ID, client hub instance ID,
   endpoint, fresh client nonce, public key, key fingerprint, canonical payload,
   and signature.
4. Server verifies:
   - key appears in parsed `authorized_keys`,
   - signature is valid,
   - both nonces are present and fresh,
   - payload binds protocol version, both node IDs, both instance IDs,
     endpoint values, nonces, and freshness data,
   - nonce has not been replayed inside the replay cache window.
5. Server responds with its signature over the same bound payload plus result
   metadata.
6. Client verifies the server key against its own authorized keys and validates
   the server signature.
7. Only after both sides authenticate may either side list agents or exchange
   prompt/response messages.

Implementation notes:

- Prefer `@noble/ed25519` if it works cleanly in the Pi/Bun runtime.
- Use Node/Bun crypto randomness for keys and nonces.
- Keep canonicalization deterministic and covered by tests.
- Use a small replay cache keyed by remote node ID and nonce pair.
- Reject unsupported key types and malformed authorized key lines.

## Local Hub Bootstrap

Startup path for each Pi instance:

1. Ensure `~/.pi/onclave/` exists.
2. Load or create persistent local identity.
3. Try to read `hub.json`.
4. If `hub.json` exists, health-check the local hub endpoint.
5. If live, register this Pi instance with the hub.
6. If missing or stale, acquire `hub.lock`.
7. Re-check `hub.json` after acquiring the lock to avoid races.
8. If still no live hub, start a hub on an available local service port.
9. Atomically write `hub.json` with endpoint, PID, node ID, hub instance ID, and
   start timestamp.
10. Register this Pi instance with the hub.

Hub shutdown should best-effort remove stale runtime files. Startup health checks
must be authoritative enough to recover from crashed processes that left state
behind.

## Hub Responsibilities

- Maintain local Pi instance registry.
- Maintain discovered LAN peer cache.
- Broadcast UDP discovery.
- Listen for UDP discovery.
- Host authenticated `wss://` hub-to-hub endpoint.
- Perform challenge-response auth.
- Block remote listing and messaging until authentication succeeds.
- Route prompt messages to local Pi instances.
- Correlate responses by message ID.
- Enforce message TTL/hop limit.
- Emit audit JSONL events.

## Pi Tool Surface

Use distinct tool names to avoid surprising existing `coms` and `coms-net`
users:

- `onclave_peers`: list discovered hubs with trust/auth state.
- `onclave_agents`: list local and trusted remote agents.
- `onclave_send`: send prompt to a trusted local or remote agent.
- `onclave_get`: poll response for an outbound message.
- `onclave_await`: await response for an outbound message.

Potential later commands, depending on open-question resolution:

- `onclave trust`: show key import instructions or trust status.
- `onclave audit`: summarize recent audit events.

Trust changes should initially be file-based through `authorized_keys` to keep v1
simple and auditable.

## Project Labeling

Registration should avoid exposing raw absolute paths in remote contexts.

Resolution order:

1. If inside a git worktree, use the worktree branch name when available.
2. Otherwise use cwd basename.
3. If inside a normal git repository with a branch, append the branch to the cwd
   basename.
4. If git data is unavailable, use cwd basename only.

Examples:

- Worktree branch `feature/onclave` -> `feature/onclave`
- Repo directory `onclave` on branch `main` -> `onclave@main`
- Non-git directory `/tmp/scratch` -> `scratch`

## Audit Events

Use append-only JSONL. Each event should include `ts`, `event`, and non-secret
metadata.

Required event groups:

- `hub_start`, `hub_stop`, `local_register`, `local_unregister`
- `discovery_seen`, `discovery_ignored`, `peer_stale`
- `auth_attempt`, `auth_success`, `auth_failure`
- `trust_loaded`, `trust_changed`
- `message_outbound`, `message_inbound`, `message_delivered`
- `response_outbound`, `response_inbound`, `message_timeout`

Default audit logging must not include prompt or response bodies. If payload
logging is ever added, it should be explicitly opt-in and redacted by default.

## Test Strategy

Follow test-first for backend/security behavior.

### Unit tests

- `authorized-keys.test.ts`
  - accepts valid `ssh-ed25519` lines,
  - ignores comments and blanks,
  - rejects unsupported key types,
  - rejects malformed OpenSSH wire payloads,
  - extracts 32-byte public keys and stable fingerprints.
- `canonical-json.test.ts`
  - stable key ordering,
  - stable nested object ordering,
  - no ambiguous serialization for signed payloads.
- `handshake.test.ts`
  - valid mutual auth succeeds,
  - unknown key fails,
  - invalid signature fails,
  - stale timestamp fails,
  - replayed nonce pair fails,
  - endpoint/node/instance tampering fails.
- `discovery.test.ts`
  - packet contains only allowed metadata fields,
  - self packets are ignored,
  - malformed or wrong-magic packets are ignored,
  - discovered peer state starts untrusted.
- `local-hub.test.ts`
  - existing live hub is reused,
  - stale `hub.json` is replaced,
  - lock prevents duplicate hub startup.
- `project-label.test.ts`
  - worktree branch label,
  - normal repo basename plus branch,
  - non-git basename fallback.
- `messages.test.ts`
  - remote messages require trusted auth,
  - message IDs correlate responses,
  - hop limit blocks loops,
  - TTL moves messages to timeout.

### Integration tests

- Start two hubs with no authorized keys and verify discovery-only visibility.
- Add each hub public key to the other's `authorized_keys` and verify mutual
  auth.
- Register one Pi instance per hub and send/await a prompt response.
- Verify audit events exist and contain no secrets or private key material.

### Manual acceptance checks

Map directly to the PRD acceptance criteria:

1. Multiple local Pi instances produce exactly one local hub.
2. UDP packet inspection shows metadata only.
3. Unknown hubs are visible but untrusted.
4. Authorized hubs complete Ed25519 challenge-response and reject bad cases.
5. Trusted hubs can send and await prompt responses.
6. Audit log includes all required event families.
7. Project labels follow git/fallback rules.

## Implementation Phases

### Phase 0: Project Scaffold

- Add TypeScript/Bun project metadata only if needed by the Pi extension runtime
  and tests.
- Add test runner configuration.
- Add empty extension entrypoint and small module boundaries.
- Add fixtures for public `ssh-ed25519` authorized key lines. Do not commit real
  private key material.

Exit criteria:

- Test command runs.
- Empty extension imports without starting network listeners at module import
  time.

### Phase 1: State, Identity, Audit, and Authorized Keys

- Implement path helpers rooted at `~/.pi/onclave/` with test override support.
- Implement atomic JSON writes for state files.
- Implement persistent node identity and app-specific Ed25519 key generation.
- Implement JSONL audit writer.
- Implement narrow `ssh-ed25519` authorized keys parser.
- Implement key fingerprints.

Exit criteria:

- Unit tests pass for state, audit, identity, and parser behavior.
- No code touches private keys under `~/.ssh/`.

### Phase 2: Local Hub Lifecycle and Registration

- Implement local hub state file read/write.
- Implement local hub health check.
- Implement lock-protected start-or-discover flow.
- Implement dynamic service port selection.
- Implement local Pi instance registration, heartbeat, stale/offline cleanup, and
  unregister on shutdown.
- Implement project label generation.

Exit criteria:

- Tests prove duplicate local hub startup is avoided.
- Multiple local registrations appear under one hub.
- Project label tests pass.

### Phase 3: UDP Discovery

- Implement UDP broadcast/listen loops with cancellable lifecycle.
- Define strict discovery packet schema and validation.
- Add peer cache with untrusted default state and stale cleanup.
- Audit discovery seen/ignored/stale events.

Exit criteria:

- Discovery unit tests pass.
- Two hubs discover each other as untrusted without exposing sensitive fields.

### Phase 4: WSS Transport and Mutual Authentication

- Implement self-signed TLS setup for hub-to-hub WebSocket transport.
- Implement deterministic canonical JSON for signed handshake payloads.
- Implement Ed25519 mutual challenge-response.
- Implement replay cache and freshness checks.
- Enforce trust gate before remote list/send operations.
- Audit auth attempts, successes, and failures.

Exit criteria:

- Handshake tests cover success and failure cases.
- Unknown, invalid, stale, replayed, and tampered handshakes fail closed.

### Phase 5: Messaging and Tool Surface

- Implement hub message model and response correlation.
- Implement local delivery to registered Pi instances.
- Implement remote delivery over authenticated hub links.
- Implement `onclave_peers`, `onclave_agents`, `onclave_send`,
  `onclave_get`, and `onclave_await`.
- Hook inbound prompts into `pi.sendMessage`.
- Hook responses from `agent_end`.
- Enforce TTL and hop limit.
- Audit inbound/outbound messages and responses without payload bodies.

Exit criteria:

- Trusted local and remote prompt/response flows pass integration tests.
- Untrusted hubs cannot list agents or send messages.

### Phase 6: Acceptance Hardening

- Run all unit and integration tests.
- Run manual multi-process local hub check.
- Inspect UDP packets for allowed fields only.
- Inspect audit logs for required events and absence of secrets/private material.
- Document minimal operator setup for importing public keys and starting Pi with
  the extension.
- Validate the end-to-end flow on two physical LAN hosts.

Exit criteria:

- All PRD acceptance criteria are demonstrably covered.
- Physical two-host LAN validation confirms discovery, trust exchange,
  authenticated remote listing, trusted remote send/get, and clean audit scans.

## Resolved Planning Questions

1. **Static peer fallback:** v1 supports manual peer fallback through explicit
   remote tool parameters (`endpoint`, `node_id`, `hub_instance_id`) and
   persistent static peers in `~/.pi/onclave/config.json`.
2. **Audit payloads:** audit logs omit prompt and response bodies by default.
   Payload logging is not part of v1.
3. **Trust changes:** v1 supports file-based trust through
   `~/.pi/onclave/authorized_keys`, with commands/tools that display the local
   public key line, show the trust file path, and validate/dedupe/append public
   key lines.
4. **`authorized_keys` options:** options are rejected in v1. Only plain
   `ssh-ed25519` public key lines are accepted.
5. **WSS primitive:** v1 uses Node `https` plus `ws`, with app-level Ed25519
   authentication as the trust gate.
6. **Hub lifetime:** v1 keeps the hub in-process inside the first Pi instance
   that wins the local hub lock. A spawned child process remains a post-v1
   hardening option.

Detailed rationale is recorded in `docs/ONCLAVE_DECISIONS.md`.

## Implementation Status Update

As of 2026-05-22, the documented manual LAN acceptance flow has been executed on two physical hosts on the same subnet.

Observed result:

- peer discovery succeeded,
- explicit trust exchange succeeded,
- trusted remote agent listing succeeded,
- trusted remote send/get succeeded,
- audit scans passed on both hosts.

This moves the implementation plan to functionally complete for the PRD v1
scope.

## PRD Gap Remediation Update

As of the latest implementation pass, the previously identified PRD gaps have
been addressed as follows:

### Gap 1: Mutual challenge-response

Resolved.

- remote auth now begins with an explicit `auth_hello` / `server_hello` step;
- the server issues a fresh nonce and signs the bound handshake payload;
- the client verifies the server signature before continuing with privileged
  remote operations;
- tests cover mutual-auth success plus stale, replay, tamper, and unknown-key
  failure cases.

### Gap 2: Discovered peer trust/auth state propagation

Resolved.

- discovered peer cache entries can now transition through `in_progress`,
  `authenticated`, and `failed` auth states;
- successful and failed remote auth attempts update the runtime peer cache so
  operator-facing peer details can reflect current trust/auth state.

### Gap 3: WSS transport decision divergence

Resolved in documentation.

- the PRD and decisions docs now record Node `https` plus `ws` as the accepted
  v1 transport choice for compatibility with the Pi extension runtime.

### Gap 4: Operator-facing endpoint reporting

Resolved.

- `onclave_status` now includes LAN-reachable `remote_endpoints` hints derived
  from non-loopback local interfaces;
- tests cover the status output for both loopback-only and LAN-reachable hosts.

## Remaining Next Steps

The remaining work is now operator UX and lifecycle polish rather than core v1
protocol or security implementation.

1. Trust management UX
    - add a trust removal or revocation workflow so operators do not need to
      edit `authorized_keys` manually for common key-removal cases;
    - consider richer trust inspection/status output if operators need a more
      guided trust-management loop;
    - evaluate a future trust request / approval flow as described in
      `docs/ONCLAVE_TRUST_UX_FUTURE.md`.
2. Reverse-direction and orchestration UX
    - add a reverse-direction acceptance helper so Host B can initiate the same
      validation flow back to Host A with the same low-friction workflow;
    - consider a higher-level acceptance orchestrator or additional prompt
      templates to reduce manual operator coordination further.
3. Static peer and operator convenience
    - consider automatic static peer aggregation or richer `config.json`
      convenience flows when UDP discovery is blocked or unreliable;
    - keep manual/static peer fallback aligned with the same trust and audit
      guarantees as discovered peers.
