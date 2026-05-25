---
created: 2026-05-21
status: active
source_prd: ../../PRDS/PRD.md
implementation_plan: ./implementation-plan.md
---

# Status: Secure LAN Pi Agent Communication

## Current State

The `Onclave` implementation now covers the core secure LAN communication
flow: local hub startup/reuse, local WSS registration and messaging, explicit
Ed25519 trust, trusted remote WSS listing/send, metadata-only discovery, Pi tool
surface, audit-safe runtime events, and physical two-host LAN acceptance.

## Verification

Last verified commands:

```bash
bun test
bun run typecheck
```

Manual verification:

- 2026-05-22: two physical LAN hosts on the same subnet completed the manual
  trust exchange, discovery, trusted remote agent listing, trusted remote
  send/get, and audit scan checks.

Result:

- `bun test`: 127 passing tests
- `bun run typecheck`: passing
- manual LAN acceptance: passed on two physical hosts

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Project Scaffold | Complete | Bun test/typecheck scaffold added. |
| Phase 1: State, Identity, Audit, Authorized Keys | Complete | Core security/state helpers implemented and tested. |
| Phase 2: Local Hub Lifecycle and Registration | Complete | Hub state, health-check reuse, stale replacement, lock-protected start flow, dynamic local service binding, local registry, local WSS registration frames, and bootstrap reuse acceptance are covered. |
| Phase 3: UDP Discovery | Complete | Packet validation, untrusted peer cache, broadcast/listen lifecycle, Node UDP adapter, runtime broadcast integration, and metadata-only acceptance coverage are in place. |
| Phase 4: WSS Transport and Mutual Authentication | Complete | Node `https` plus `ws` WSS transport, mutual signed handshake verification, transport auth gate, frame processor, hub runtime integration, and trusted remote acceptance coverage are in place. |
| Phase 5: Messaging and Tool Surface | Complete | Local message routing, response correlation, timeout cleanup, WSS send_prompt delivery, Pi status/list/send/get/await tools, `agent_end` response submission, trust info/add, static peer listing, trusted remote client helpers, and explicit/static trusted remote list/send/get tools are implemented. |
| Phase 6: Acceptance Hardening | Complete | Automated acceptance passes, the manual multi-host LAN runbook is documented, prompt-template helpers reduce operator friction, and a two-physical-host LAN run completed successfully with passing audit scans. |

## Implemented Files

Extension:

- `extensions/onclave-comms`

Runtime modules:

- `extensions/onclave-comms/src/lib/audit.ts`
- `extensions/onclave-comms/src/lib/audited-runtime.ts`
- `extensions/onclave-comms/src/lib/authorized-keys.ts`
- `extensions/onclave-comms/src/lib/bootstrap.ts`
- `extensions/onclave-comms/src/lib/config.ts`
- `extensions/onclave-comms/src/lib/canonical-json.ts`
- `extensions/onclave-comms/src/lib/discovery.ts`
- `extensions/onclave-comms/src/lib/extension-helpers.ts`
- `extensions/onclave-comms/src/lib/handshake.ts`
- `extensions/onclave-comms/src/lib/hub-runtime.ts`
- `extensions/onclave-comms/src/lib/identity.ts`
- `extensions/onclave-comms/src/lib/local-hub.ts`
- `extensions/onclave-comms/src/lib/local-registry.ts`
- `extensions/onclave-comms/src/lib/local-service.ts`
- `extensions/onclave-comms/src/lib/messages.ts`
- `extensions/onclave-comms/src/lib/project-label.ts`
- `extensions/onclave-comms/src/lib/remote-client.ts`
- `extensions/onclave-comms/src/lib/state.ts`
- `extensions/onclave-comms/src/lib/tls.ts`
- `extensions/onclave-comms/src/lib/transport.ts`
- `extensions/onclave-comms/src/lib/trust.ts`
- `extensions/onclave-comms/src/lib/wss-transport.ts`

Tests:

- `extensions/onclave-comms/tests/acceptance-host-script.test.ts`
- `extensions/onclave-comms/tests/acceptance.test.ts`
- `extensions/onclave-comms/tests/audit.test.ts`
- `extensions/onclave-comms/tests/audited-runtime.test.ts`
- `extensions/onclave-comms/tests/authorized-keys.test.ts`
- `extensions/onclave-comms/tests/bootstrap.test.ts`
- `extensions/onclave-comms/tests/canonical-json.test.ts`
- `extensions/onclave-comms/tests/config.test.ts`
- `extensions/onclave-comms/tests/discovery-service.test.ts`
- `extensions/onclave-comms/tests/discovery.test.ts`
- `extensions/onclave-comms/tests/extension-helpers.test.ts`
- `extensions/onclave-comms/tests/extension.test.ts`
- `extensions/onclave-comms/tests/handshake.test.ts`
- `extensions/onclave-comms/tests/hub-runtime.test.ts`
- `extensions/onclave-comms/tests/identity-key.test.ts`
- `extensions/onclave-comms/tests/identity.test.ts`
- `extensions/onclave-comms/tests/local-hub.test.ts`
- `extensions/onclave-comms/tests/local-registry.test.ts`
- `extensions/onclave-comms/tests/local-service.test.ts`
- `extensions/onclave-comms/tests/messages.test.ts`
- `extensions/onclave-comms/tests/project-label.test.ts`
- `extensions/onclave-comms/tests/remote-client.test.ts`
- `extensions/onclave-comms/tests/state.test.ts`
- `extensions/onclave-comms/tests/tls.test.ts`
- `extensions/onclave-comms/tests/transport-frame.test.ts`
- `extensions/onclave-comms/tests/trust.test.ts`
- `extensions/onclave-comms/tests/transport.test.ts`
- `extensions/onclave-comms/tests/wss-transport.test.ts`

Documentation:

- `./decisions.md`
- `./manual-acceptance.md`
- `./operator-guide.md`
- `./implementation-plan.md`
- `docs/PRD.md`
- `./status.md`

Scripts:

- `extensions/onclave-comms/scripts/onclave-acceptance-host.ts`

Project/config files:

- `package.json`
- `bun.lock`
- `bunfig.toml`
- `tsconfig.json`
- `./decisions.md`
- `./manual-acceptance.md`
- `./implementation-plan.md`

## Completed Capabilities

- Narrow `ssh-ed25519` `authorized_keys` parser.
- Deterministic canonical JSON for signed payloads.
- JSONL audit writer with sensitive field-name rejection.
- State path helpers rooted under `~/.pi/onclave/`.
- Atomic JSON writes.
- App-specific Ed25519 identity and signing key generation.
- Persistent self-signed TLS material loading/generation under `~/.pi/onclave/` without requiring an external OpenSSL binary.
- Authorized key trust loading from `~/.pi/onclave/authorized_keys`.
- Public key export formatting for operator trust setup.
- Trust append helper validates and dedupes public `ssh-ed25519` key lines.
- Static peer config loading and validation from `~/.pi/onclave/config.json`.
- Local hub bootstrap loads identity, trust, TLS material, and starts or reuses
  hub state.
- Local hub state read/write and validation.
- Existing live hub reuse via injected health checks.
- Stale hub state replacement.
- Lock-protected local hub start-or-discover flow to avoid duplicate startup.
- Dynamic local service binding with OS-assigned port fallback on conflicts.
- Local Pi instance registration and upsert behavior.
- Local heartbeat telemetry updates.
- Stale/offline local agent cleanup.
- Local unregister behavior.
- Project label resolution from git worktree/branch context with basename
  fallback.
- Metadata-only discovery packet creation/parsing.
- Discovered peer cache with untrusted default state.
- UDP discovery service lifecycle with immediate and interval broadcasts.
- Inbound UDP packet handling through validated discovery packets.
- Node UDP socket adapter for runtime discovery.
- Core Ed25519 mutual handshake verification:
    - server hello with fresh server nonce,
    - authorized-key check,
    - client signature verification,
    - server signature verification,
    - stale timestamp rejection,
    - replayed nonce-pair rejection.
- Transport auth gate blocks list/message privileges before authentication.
- Transport auth gate enables v1 privileges only after authorized handshake.
- Hub frame processor handles local register/unregister/send/get frames, client
  auth, gated agent listing, gated response lookup, and gated prompt send frames.
- Minimal Node `https` plus `ws` WSS wrapper handles frame exchange over
  self-signed TLS.
- Composed hub runtime starts WSS transport, broadcasts discovery, registers
  local agents, and exposes auth-gated remote listing.
- Message router delivers prompts to registered local agents.
- Message router correlates responses by message ID, exposes response lookup,
  and marks expired messages as timeout.
- Authenticated WSS `send_prompt` frames route through the message router and
  surface routing failures.
- Extension-facing helper builds local agent registrations from session/runtime
  metadata with project labels and stable defaults.
- Initial Pi extension entrypoint bootstraps/reuses local hub state, registers
  local agents directly or through local WSS registration frames, exposes
  trust setup/add, status/peer/static-peer/agent listing plus local and
  explicit/static trusted remote send/get/await tools, injects inbound prompts,
  and submits `agent_end` responses.
- Remote client helper authenticates to trusted WSS peers for agent listing,
  prompt send, and response lookup.
- Hub runtime can aggregate agent listings from trusted remote peers.
- Audit helper records lifecycle, trust, discovery, local registration,
  messaging, response, and auth events without prompt/response bodies.
- Hub runtime emits audit metadata for hub start/stop, local registration,
  unregister, discovery, auth, prompt routing, and response submission paths.
- Remote client emits audit metadata for auth, outbound prompts, and response
  lookup results.
- Automated acceptance coverage verifies first hub startup, second bootstrap
  reuse, local WSS registration/send/response lookup, metadata-only discovery
  packets, and trusted remote WSS listing/send after public key exchange.
- Manual multi-host LAN acceptance runbook is documented in
  `./manual-acceptance.md`.
- Host-side acceptance helper script at
  `extensions/onclave-comms/scripts/onclave-acceptance-host.ts` initializes
  local identity when needed,
  prints local public key/endpoint metadata, writes optional static peers, and
  scans audit logs for obvious secret markers.
- Physical two-host LAN acceptance completed successfully with:
    - UDP peer discovery,
    - explicit trust exchange,
    - authenticated remote agent listing,
    - trusted remote send/get response correlation,
    - passing audit scans on both hosts.

## Security Notes

- Private signing keys and TLS keys are generated under `~/.pi/onclave/`, not
  under `~/.ssh/`.
- `authorized_keys` parsing supports only `ssh-ed25519` in v1.
- `authorized_keys` options are rejected in v1.
- Discovery packets are metadata-only and exclude prompts, secrets, private keys,
  cwd, and path fields.
- Audit events reject sensitive field names such as prompt, response, secret,
  token, credential, private, and key material.
- WSS transport uses self-signed TLS for encrypted transport; app-level Ed25519
  auth is the trust gate.
- WSS transport uses Node `https` plus `ws` with self-signed TLS and certificate
  verification disabled at the WebSocket layer. App-level Ed25519 mutual auth
  remains the trust gate.

## Resolved Implementation Decisions

1. Hub lifetime: v1 keeps the hub in-process inside the first Pi instance that
   wins the local hub lock. A spawned child process remains a post-v1 hardening
   option.
2. Static/manual peers: v1 supports manual fallback through explicit remote tool
   parameters (`endpoint`, `node_id`, `hub_instance_id`) and persistent static
   peers in `~/.pi/onclave/config.json`.
3. Trust import UX: v1 supports file-based trust through
   `~/.pi/onclave/authorized_keys`, with `/onclave-trust`,
   `onclave_trust_info`, and `onclave_trust_add` for public-key setup.

See `./decisions.md` for rationale and consequences.

## Next Actions

The remaining work is post-v1 operator polish:

1. Trust management UX
    - add a trust removal or revocation helper so operators do not need to edit
      `authorized_keys` manually for common removal cases;
    - consider richer trust inspection/status output if operators need it;
    - use `./trust-ux-future.md` as the future design reference for
      a trust request / approval workflow.
2. Reverse-direction and orchestration UX
    - add a reverse-direction acceptance helper so either host can run the
      initiator flow with minimal operator coordination;
    - consider a higher-level acceptance orchestrator or additional prompt
      templates for multi-host validation runs.
3. Static peer/operator convenience
    - consider automatic static peer aggregation or richer static-peer workflows
      when UDP discovery is blocked or unreliable.
