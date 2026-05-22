---
created: 2026-05-21
status: active
source_prd: ./PRD.md
implementation_plan: ./IMPLEMENTATION_PLAN.md
---

# Status: Secure LAN Pi Agent Communication

## Current State

The `coms-lan` implementation now covers the core secure LAN communication
flow: local hub startup/reuse, local WSS registration and messaging, explicit
Ed25519 trust, trusted remote WSS listing/send, metadata-only discovery, Pi tool
surface, and audit-safe runtime events.

## Verification

Last verified commands:

```bash
bun test
bun run typecheck
```

Result:

- `bun test`: 118 passing tests
- `bun run typecheck`: passing

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Project Scaffold | Complete | Bun test/typecheck scaffold added. |
| Phase 1: State, Identity, Audit, Authorized Keys | Complete | Core security/state helpers implemented and tested. |
| Phase 2: Local Hub Lifecycle and Registration | Complete | Hub state, health-check reuse, stale replacement, lock-protected start flow, dynamic local service binding, local registry, local WSS registration frames, and bootstrap reuse acceptance are covered. |
| Phase 3: UDP Discovery | Complete | Packet validation, untrusted peer cache, broadcast/listen lifecycle, Node UDP adapter, runtime broadcast integration, and metadata-only acceptance coverage are in place. |
| Phase 4: WSS Transport and Mutual Authentication | Complete | Bun WSS transport, signed handshake verifier, transport auth gate, frame processor, hub runtime integration, and trusted remote acceptance coverage are in place. |
| Phase 5: Messaging and Tool Surface | Mostly complete | Local message routing, response correlation, timeout cleanup, WSS send_prompt delivery, Pi status/list/send/get/await tools, `agent_end` response submission, trust info/add, static peer listing, trusted remote client helpers, and explicit/static trusted remote list/send/get tools are implemented. |
| Phase 6: Acceptance Hardening | Partial | Automated acceptance covers local bootstrap reuse, local WSS register/send/get, metadata-only discovery packets, and trusted remote WSS list/send with exchanged keys. Manual multi-host LAN runbook is documented; physical LAN execution remains. |

## Implemented Files

Extension:

- `extensions/coms-lan.ts`

Runtime modules:

- `src/coms-lan/audit.ts`
- `src/coms-lan/audited-runtime.ts`
- `src/coms-lan/authorized-keys.ts`
- `src/coms-lan/bootstrap.ts`
- `src/coms-lan/config.ts`
- `src/coms-lan/canonical-json.ts`
- `src/coms-lan/discovery.ts`
- `src/coms-lan/extension-helpers.ts`
- `src/coms-lan/handshake.ts`
- `src/coms-lan/hub-runtime.ts`
- `src/coms-lan/identity.ts`
- `src/coms-lan/local-hub.ts`
- `src/coms-lan/local-registry.ts`
- `src/coms-lan/local-service.ts`
- `src/coms-lan/messages.ts`
- `src/coms-lan/project-label.ts`
- `src/coms-lan/remote-client.ts`
- `src/coms-lan/state.ts`
- `src/coms-lan/tls.ts`
- `src/coms-lan/transport.ts`
- `src/coms-lan/trust.ts`
- `src/coms-lan/wss-transport.ts`

Tests:

- `tests/coms-lan/acceptance-host-script.test.ts`
- `tests/coms-lan/acceptance.test.ts`
- `tests/coms-lan/audit.test.ts`
- `tests/coms-lan/audited-runtime.test.ts`
- `tests/coms-lan/authorized-keys.test.ts`
- `tests/coms-lan/bootstrap.test.ts`
- `tests/coms-lan/canonical-json.test.ts`
- `tests/coms-lan/config.test.ts`
- `tests/coms-lan/discovery-service.test.ts`
- `tests/coms-lan/discovery.test.ts`
- `tests/coms-lan/extension-helpers.test.ts`
- `tests/coms-lan/extension.test.ts`
- `tests/coms-lan/handshake.test.ts
- `tests/coms-lan/hub-runtime.test.ts`
- `tests/coms-lan/identity-key.test.ts`
- `tests/coms-lan/identity.test.ts`
- `tests/coms-lan/local-hub.test.ts`
- `tests/coms-lan/local-registry.test.ts`
- `tests/coms-lan/local-service.test.ts`
- `tests/coms-lan/messages.test.ts`
- `tests/coms-lan/project-label.test.ts`
- `tests/coms-lan/remote-client.test.ts`
- `tests/coms-lan/state.test.ts`
- `tests/coms-lan/tls.test.ts`
- `tests/coms-lan/transport-frame.test.ts`
- `tests/coms-lan/trust.test.ts`
- `tests/coms-lan/transport.test.ts`
- `tests/coms-lan/wss-transport.test.ts`

Documentation:

- `docs/COMS_LAN_DECISIONS.md`
- `docs/COMS_LAN_MANUAL_ACCEPTANCE.md`
- `docs/COMS_LAN_OPERATOR_GUIDE.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/PRD.md`
- `docs/STATUS.md`

Scripts:

- `scripts/coms-lan-acceptance-host.ts`

Project/config files:

- `package.json`
- `bun.lock`
- `bunfig.toml`
- `tsconfig.json`
- `docs/COMS_LAN_DECISIONS.md`
- `docs/COMS_LAN_MANUAL_ACCEPTANCE.md`
- `docs/IMPLEMENTATION_PLAN.md`

## Completed Capabilities

- Narrow `ssh-ed25519` `authorized_keys` parser.
- Deterministic canonical JSON for signed payloads.
- JSONL audit writer with sensitive field-name rejection.
- State path helpers rooted under `~/.pi/coms-lan/`.
- Atomic JSON writes.
- App-specific Ed25519 identity and signing key generation.
- Persistent self-signed TLS material loading/generation under `~/.pi/coms-lan/`.
- Authorized key trust loading from `~/.pi/coms-lan/authorized_keys`.
- Public key export formatting for operator trust setup.
- Trust append helper validates and dedupes public `ssh-ed25519` key lines.
- Static peer config loading and validation from `~/.pi/coms-lan/config.json`.
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
- Core Ed25519 client handshake verification:
    - authorized-key check,
    - signature verification,
    - stale timestamp rejection,
    - replayed nonce-pair rejection.
- Transport auth gate blocks list/message privileges before authentication.
- Transport auth gate enables v1 privileges only after authorized handshake.
- Hub frame processor handles local register/unregister/send/get frames, client
  auth, gated agent listing, gated response lookup, and gated prompt send frames.
- Minimal Bun WSS server/client wrapper handles frame exchange over self-signed
  TLS.
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
  `docs/COMS_LAN_MANUAL_ACCEPTANCE.md`.
- Host-side acceptance helper script initializes local identity when needed,
  prints local public key/endpoint metadata, writes optional static peers, and
  scans audit logs for obvious secret markers.

## Security Notes

- Private signing keys and TLS keys are generated under `~/.pi/coms-lan/`, not
  under `~/.ssh/`.
- `authorized_keys` parsing supports only `ssh-ed25519` in v1.
- `authorized_keys` options are rejected in v1.
- Discovery packets are metadata-only and exclude prompts, secrets, private keys,
  cwd, and path fields.
- Audit events reject sensitive field names such as prompt, response, secret,
  token, credential, private, and key material.
- WSS transport uses self-signed TLS for encrypted transport; app-level Ed25519
  auth is the trust gate.
- WSS runtime spike succeeded with Bun native `Bun.serve({ tls, websocket })` and
  native `WebSocket` using self-signed TLS with certificate verification disabled
  at the WebSocket layer. App-level Ed25519 auth remains the trust gate.

## Resolved Implementation Decisions

1. Hub lifetime: v1 keeps the hub in-process inside the first Pi instance that
   wins the local hub lock. A spawned child process remains a post-v1 hardening
   option.
2. Static/manual peers: v1 supports manual fallback through explicit remote tool
   parameters (`endpoint`, `node_id`, `hub_instance_id`) and persistent static
   peers in `~/.pi/coms-lan/config.json`.
3. Trust import UX: v1 supports file-based trust through
   `~/.pi/coms-lan/authorized_keys`, with `/coms-lan-trust`,
   `coms_lan_trust_info`, and `coms_lan_trust_add` for public-key setup.

See `docs/COMS_LAN_DECISIONS.md` for rationale and consequences.

## Next Actions

1. Execute the documented manual multi-host LAN runbook on two physical hosts.
2. Consider post-v1 trust removal UX or automatic static peer aggregation if
   manual validation shows they are needed.
