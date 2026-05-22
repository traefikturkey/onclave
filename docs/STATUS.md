---
created: 2026-05-21
status: active
source_prd: ./PRD.md
implementation_plan: ./IMPLEMENTATION_PLAN.md
---

# Status: Secure LAN Pi Agent Communication

## Current State

Initial planning, security foundation, and local hub state/lock flow are in
place for `coms-lan`.

The repository now has a Bun/TypeScript scaffold, unit tests, core modules, and
an initial Pi extension entrypoint. Remote send/get/await tools and full
multi-process local registration are not implemented yet.

## Verification

Last verified commands:

```bash
bun test
bun run typecheck
```

Result:

- `bun test`: 87 passing tests
- `bun run typecheck`: passing

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Project Scaffold | Complete | Bun test/typecheck scaffold added. |
| Phase 1: State, Identity, Audit, Authorized Keys | Complete | Core security/state helpers implemented and tested. |
| Phase 2: Local Hub Lifecycle and Registration | Mostly complete | Hub state, health-check reuse, stale replacement, lock-protected start flow, dynamic local service binding, local registry, and local WSS registration frames implemented; broader multi-process acceptance remains. |
| Phase 3: UDP Discovery | Mostly complete | Packet validation, untrusted peer cache, broadcast/listen lifecycle, and Node UDP adapter implemented; hub integration remains. |
| Phase 4: WSS Transport and Mutual Authentication | Mostly complete | Bun WSS spike passed; signed handshake verifier, transport auth gate, frame processor, minimal WSS server/client wrapper, and composed hub runtime implemented; extension integration remains. |
| Phase 5: Messaging and Tool Surface | Partial | Local message routing, response correlation, timeout cleanup, WSS send_prompt delivery, and initial Pi status/list tools are implemented; remote send/get/await tools remain. |
| Phase 6: Acceptance Hardening | Not started | Manual multi-process and LAN checks remain. |

## Implemented Files

Extension:

- `extensions/coms-lan.ts`

Runtime modules:

- `src/coms-lan/audit.ts`
- `src/coms-lan/authorized-keys.ts`
- `src/coms-lan/bootstrap.ts`
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
- `src/coms-lan/state.ts`
- `src/coms-lan/tls.ts`
- `src/coms-lan/transport.ts`
- `src/coms-lan/trust.ts`
- `src/coms-lan/wss-transport.ts`

Tests:

- `tests/coms-lan/audit.test.ts`
- `tests/coms-lan/authorized-keys.test.ts`
- `tests/coms-lan/bootstrap.test.ts`
- `tests/coms-lan/canonical-json.test.ts`
- `tests/coms-lan/discovery-service.test.ts`
- `tests/coms-lan/discovery.test.ts`
- `tests/coms-lan/extension-helpers.test.ts`
- `tests/coms-lan/handshake.test.ts`
- `tests/coms-lan/hub-runtime.test.ts`
- `tests/coms-lan/identity.test.ts`
- `tests/coms-lan/local-hub.test.ts`
- `tests/coms-lan/local-registry.test.ts`
- `tests/coms-lan/local-service.test.ts`
- `tests/coms-lan/messages.test.ts`
- `tests/coms-lan/project-label.test.ts`
- `tests/coms-lan/state.test.ts`
- `tests/coms-lan/tls.test.ts`
- `tests/coms-lan/transport-frame.test.ts`
- `tests/coms-lan/trust.test.ts`
- `tests/coms-lan/transport.test.ts`
- `tests/coms-lan/wss-transport.test.ts`

Project/config files:

- `package.json`
- `bun.lock`
- `bunfig.toml`
- `tsconfig.json`
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
- Hub frame processor handles local register/unregister frames, client auth,
  gated agent listing, and gated prompt send frames.
- Minimal Bun WSS server/client wrapper handles frame exchange over self-signed
  TLS.
- Composed hub runtime starts WSS transport, broadcasts discovery, registers
  local agents, and exposes auth-gated remote listing.
- Message router delivers prompts to registered local agents.
- Message router correlates responses by message ID and marks expired messages
  as timeout.
- Authenticated WSS `send_prompt` frames route through the message router and
  surface routing failures.
- Extension-facing helper builds local agent registrations from session/runtime
  metadata with project labels and stable defaults.
- Initial Pi extension entrypoint bootstraps/reuses local hub state, registers
  local agents directly or through local WSS registration frames, and exposes
  status/peer/agent listing tools.

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

## Open Implementation Decisions

1. Hub lifetime: decide whether the hub runs in-process in the first Pi instance
   or as a spawned child process.
2. Static peers: decide whether v1 includes manual peer endpoints as a fallback
   when UDP broadcast is unavailable.
3. Trust UX: decide whether v1 is file-edit only for `authorized_keys` or also
   includes a command to import keys.

## Next Actions

1. Add Pi tool surface for remote send/get/await behavior.
2. Add `agent_end` response submission wiring.
3. Add end-to-end acceptance checks for local hub startup and trusted remote
   listing.
4. Add audit integration around discovery, auth, and messaging events.
