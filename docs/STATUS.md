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

The repository now has a Bun/TypeScript scaffold, unit tests, and core modules
for the first implementation slices. No Pi extension entrypoint, WSS transport,
or messaging tools are implemented yet.

## Verification

Last verified commands:

```bash
bun test
bun run typecheck
```

Result:

- `bun test`: 64 passing tests
- `bun run typecheck`: passing

## Phase Progress

| Phase | Status | Notes |
|---|---|---|
| Phase 0: Project Scaffold | Complete | Bun test/typecheck scaffold added. |
| Phase 1: State, Identity, Audit, Authorized Keys | Complete | Core security/state helpers implemented and tested. |
| Phase 2: Local Hub Lifecycle and Registration | Mostly complete | Hub state, health-check reuse, stale replacement, lock-protected start flow, dynamic local service binding, and local registry implemented; integration into extension remains. |
| Phase 3: UDP Discovery | Mostly complete | Packet validation, untrusted peer cache, broadcast/listen lifecycle, and Node UDP adapter implemented; hub integration remains. |
| Phase 4: WSS Transport and Mutual Authentication | Partial | Bun WSS spike passed; signed handshake verifier, transport auth gate, and frame processor implemented; full WSS server/client remains. |
| Phase 5: Messaging and Tool Surface | Not started | Needs routing, response correlation, and Pi tools. |
| Phase 6: Acceptance Hardening | Not started | Manual multi-process and LAN checks remain. |

## Implemented Files

Runtime modules:

- `src/coms-lan/audit.ts`
- `src/coms-lan/authorized-keys.ts`
- `src/coms-lan/canonical-json.ts`
- `src/coms-lan/discovery.ts`
- `src/coms-lan/handshake.ts`
- `src/coms-lan/identity.ts`
- `src/coms-lan/local-hub.ts`
- `src/coms-lan/local-registry.ts`
- `src/coms-lan/local-service.ts`
- `src/coms-lan/project-label.ts`
- `src/coms-lan/state.ts`
- `src/coms-lan/transport.ts`

Tests:

- `tests/coms-lan/audit.test.ts`
- `tests/coms-lan/authorized-keys.test.ts`
- `tests/coms-lan/canonical-json.test.ts`
- `tests/coms-lan/discovery-service.test.ts`
- `tests/coms-lan/discovery.test.ts`
- `tests/coms-lan/handshake.test.ts`
- `tests/coms-lan/identity.test.ts`
- `tests/coms-lan/local-hub.test.ts`
- `tests/coms-lan/local-registry.test.ts`
- `tests/coms-lan/local-service.test.ts`
- `tests/coms-lan/project-label.test.ts`
- `tests/coms-lan/state.test.ts`
- `tests/coms-lan/transport-frame.test.ts`
- `tests/coms-lan/transport.test.ts`

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
- Hub frame processor handles client auth, gated agent listing, and gated prompt
  send frames.

## Security Notes

- Private keys are generated under `~/.pi/coms-lan/`, not under `~/.ssh/`.
- `authorized_keys` parsing supports only `ssh-ed25519` in v1.
- `authorized_keys` options are rejected in v1.
- Discovery packets are metadata-only and exclude prompts, secrets, private keys,
  cwd, and path fields.
- Audit events reject sensitive field names such as prompt, response, secret,
  token, credential, private, and key material.
- The current handshake verifier is app-level Ed25519 auth only; full WSS
  transport is not implemented yet.
- WSS runtime spike succeeded with Bun native `Bun.serve({ tls, websocket })` and
  native `WebSocket` using self-signed TLS with certificate verification disabled
  at the WebSocket layer. App-level Ed25519 auth remains the trust gate.

## Open Implementation Decisions

1. WSS primitive: choose the stable Bun/Pi-compatible WebSocket/TLS server/client
   approach.
2. Hub lifetime: decide whether the hub runs in-process in the first Pi instance
   or as a spawned child process.
3. Static peers: decide whether v1 includes manual peer endpoints as a fallback
   when UDP broadcast is unavailable.
4. Trust UX: decide whether v1 is file-edit only for `authorized_keys` or also
   includes a command to import keys.

## Next Actions

1. Add WSS hub server/client tests using the frame processor.
2. Implement the minimal WSS server/client wrapper.
3. Start the Pi extension entrypoint once discovery and local hub boundaries are
   ready to compose.
4. Add integration tests that compose local hub lifecycle, registry, discovery,
   and auth gating.
5. Add message routing tests after transport auth gates are in place.
