---
created: 2026-05-20
status: draft
---

# PRD: Secure LAN Pi Agent Communication

## Problem

Pi can already support local and networked agent communication through extension patterns, but LAN-based multi-machine coordination needs a secure discovery and authentication layer before it is safe to expose agent messaging. A random Pi instance on the LAN must not be able to discover an existing Pi hub and command its agents.

The goal is to create a new `coms-lan.ts` system that makes Pi agents network-aware on a trusted LAN while keeping authorization explicit, auditable, and scoped to authenticated remote machine hubs.

## Users / Jobs To Be Done

- Primary user: A Pi operator running multiple Pi instances across one or more trusted machines on a LAN.
- Job/story: As an operator, I want Pi instances on different machines to discover each other securely, authenticate hub-to-hub, list available trusted peers/agents, and exchange prompt/response messages without allowing unknown LAN peers to issue commands.
- Current workaround: Manually start separate agents, use local-only communication, use a centralized network hub without LAN discovery, or copy/paste context between machines.

## Goals

1. Build a new `coms-lan.ts` Pi communication system with one machine-level hub per machine and multiple local Pi instances registered to that hub.
2. Support UDP LAN discovery so hubs can find each other without static configuration.
3. Require authenticated hub-to-hub communication before any messaging using `authorized_keys`-style Ed25519 public keys.
4. Use `wss://` WebSocket over self-signed TLS for direct hub-to-hub transport after authentication.
5. Keep unknown discovered hubs visible as untrusted, with no messaging or communication privileges.
6. Provide audit logs for discovery, authentication, trust changes, inbound messages, and outbound messages.
7. Reuse the relevant design lessons from Joyride Docker cluster discovery and Pi `coms`/`coms-net` while building a separate `coms-lan.ts` implementation.

## Non-Goals

- No multi-hop routing in v1.
- No SWIM/memberlist implementation in v1 unless later planning proves simple UDP discovery is insufficient.
- No modification of `coms.ts` or `coms-net.ts` as the primary implementation path.
- No automatic trust of discovered LAN peers.
- No reading, writing, or modifying private keys under `~/.ssh/`.
- No support for RSA, ECDSA, SSH certificates, or complex `authorized_keys` options in v1 unless explicitly added during planning.
- No production-grade PKI or certificate authority workflow in v1.

## Requirements

### Functional Requirements

- Implement a new Pi extension/system named `coms-lan.ts`.
- Use one hub per machine.
- Allow multiple local Pi instances to register with the local hub.
- Local Pi instances must discover an existing local hub before attempting to start one.
- Local hub discovery must use state under `~/.pi/coms-lan/`, including a hub state file and a lock to avoid startup races.
- If no live local hub exists, one Pi instance may start the hub and publish its local hub state.
- The hub must bind without fixed-port conflicts, using an available local port and publishing the selected endpoint.
- LAN discovery must use UDP broadcast similar to the Joyride Docker cluster discovery model.
- Discovery packets must not include secrets, private keys, prompt text, or sensitive local paths.
- Unknown discovered hubs must be visible as untrusted.
- Untrusted hubs must not be allowed to send messages, list local agents, or open authenticated communication beyond the discovery/auth attempt.
- Remote hub authorization must be based on Ed25519 public keys from an imported or configured `authorized_keys` file.
- Public keys are authorization credentials, not node identity.
- Persistent node/hub identity must use generated IDs stored under `~/.pi/coms-lan/`.
- Running hub and Pi process identity must use runtime instance IDs.
- Pi instance registration must include session ID, process/runtime instance ID, project label, and local delivery endpoint.
- Project display label must use git worktree branch name when available.
- Project display label must fall back to cwd basename, with git branch appended when available.
- After UDP discovery, hubs must connect directly hub-to-hub using `wss://` WebSocket over self-signed TLS.
- Hub-to-hub authentication must perform an Ed25519 challenge-response before allowing messaging.
- Challenge-response must include fresh nonces from both sides and bind protocol version, client node ID, server node ID, client instance ID, server instance ID, endpoint, and freshness data.
- Reject unknown public keys.
- Reject invalid signatures.
- Reject stale or replayed handshakes.
- Trusted keys may send messages according to v1 policy.
- V1 includes full prompt send/await gated behind trusted-key authentication and audit logging.
- All state, config, runtime files, and audit logs must live under `~/.pi/coms-lan/`.
- Audit logging must include discovery, authentication success/failure, trust changes, inbound messages, and outbound messages.

### Non-Functional Requirements

- Secure by default: discovered peers are untrusted until authorized.
- Minimal dependency footprint.
- Prefer well-maintained TypeScript/JavaScript crypto primitives over custom cryptography.
- Prefer `@noble/ed25519` for Ed25519 signing and verification if planning confirms it works in the Pi/Bun runtime.
- Implement only a narrow `ssh-ed25519` `authorized_keys` parser in v1 if no small maintained parser is clearly better.
- Do not depend on a full SSH protocol implementation for v1.
- Use deterministic message canonicalization for signed handshake payloads.
- Keep implementation simple and direct: no routing through third-party hubs in v1.
- Cross-platform behavior must account for Windows and POSIX paths.
- Examples, tests, and documentation must not contain secrets or real private key material.

## References / Prior Art

### Primary Prior Art: Joyride Docker Cluster

Use Joyride Docker cluster as the primary reference for LAN discovery shape, lifecycle, configuration defaults, and test patterns.

- Repository: https://github.com/traefikturkey/joyride/tree/main/plugins/docker-cluster
- Cluster manager: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/cluster.go
- Raw cluster manager: https://raw.githubusercontent.com/traefikturkey/joyride/main/plugins/docker-cluster/cluster.go
- UDP discovery: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/discovery.go
- Raw UDP discovery: https://raw.githubusercontent.com/traefikturkey/joyride/main/plugins/docker-cluster/discovery.go
- Cluster config: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/cluster_config.go
- Raw cluster config: https://raw.githubusercontent.com/traefikturkey/joyride/main/plugins/docker-cluster/cluster_config.go
- Cluster tests: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/cluster_test.go
- Config tests: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/cluster_config_test.go
- Delegate tests: https://github.com/traefikturkey/joyride/blob/main/plugins/docker-cluster/delegate_test.go

Planning must compare the proposed `coms-lan` design against Joyride before coding, especially UDP packet format, discovery interval, peer cache behavior, config defaults, startup/shutdown lifecycle, and test coverage patterns.

### Pi Communication Prior Art

Use these as references for Pi extension shape, tool UX, local agent registration, and message semantics.

- Local same-machine Pi comms: https://github.com/disler/pi-vs-claude-code/blob/main/extensions/coms.ts
- Raw local comms: https://raw.githubusercontent.com/disler/pi-vs-claude-code/main/extensions/coms.ts
- Networked Pi comms: https://github.com/disler/pi-vs-claude-code/blob/main/extensions/coms-net.ts
- Raw networked comms: https://raw.githubusercontent.com/disler/pi-vs-claude-code/main/extensions/coms-net.ts
- Networked comms server: https://github.com/disler/pi-vs-claude-code/blob/main/scripts/coms-net-server.ts

### Authentication and Crypto References

- OpenSSH `authorized_keys` manual: https://man.openbsd.org/sshd.8#AUTHORIZED_KEYS_FILE_FORMAT
- OpenSSH `sshd` manual: https://man.openbsd.org/sshd.8
- RFC 8709, Ed25519 and Ed448 public key algorithms for SSH: https://www.rfc-editor.org/rfc/rfc8709
- Node.js crypto API: https://nodejs.org/api/crypto.html
- Node.js TLS API: https://nodejs.org/api/tls.html
- Node.js HTTPS API: https://nodejs.org/api/https.html
- `@noble/ed25519`: https://www.npmjs.com/package/@noble/ed25519
- Noble Ed25519 repository: https://github.com/paulmillr/noble-ed25519
- `sshpk` package, possible parser reference: https://www.npmjs.com/package/sshpk
- `sshpk` repository: https://github.com/joyent/node-sshpk
- `ssh2` package, full SSH protocol alternative: https://www.npmjs.com/package/ssh2
- `ssh2` repository: https://github.com/mscdex/ssh2

### Optional Conceptual Background

- HashiCorp memberlist: https://github.com/hashicorp/memberlist
- Memberlist Go docs: https://pkg.go.dev/github.com/hashicorp/memberlist
- SWIM protocol paper: https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf

## Authentication Library Strategy

- Prefer `@noble/ed25519` for Ed25519 signing and verification if it works cleanly in the Pi extension runtime.
- Do not depend on `ssh2` or another full SSH protocol library for v1 unless planning finds the custom handshake unsafe or impractical.
- Avoid `sshpk` as a default dependency unless planning finds its parser value outweighs its dependency surface.
- Implement a narrow `authorized_keys` parser for `ssh-ed25519` only if no better maintained parser is selected.
- The parser should ignore blank lines and comments, accept only `ssh-ed25519`, base64-decode the OpenSSH wire payload, parse the `ssh-ed25519` key type and 32-byte public key, and reject everything else.
- Add parser fixtures generated by `ssh-keygen -t ed25519`.
- Do not read or modify private keys under `~/.ssh/`.
- Generate app-specific hub signing keys under `~/.pi/coms-lan/`.

## Acceptance Criteria

1. [ ] A local Pi instance can discover or start the single local machine hub without port conflicts.
   - Verify: Start multiple Pi instances on the same machine with `coms-lan.ts` enabled.
   - Pass: Exactly one local hub is active and each Pi instance registers with it.
   - Fail: Multiple hubs race unnecessarily, fixed port conflicts occur, or instances cannot register.

2. [ ] A hub broadcasts LAN discovery without exposing sensitive data.
   - Verify: Inspect emitted UDP discovery packet fields in tests or local capture.
   - Pass: Packet contains protocol/version/node/endpoint metadata only, with no prompts, secrets, private keys, or raw cwd paths.
   - Fail: Packet exposes sensitive data or contains fields needed only after authentication.

3. [ ] Unknown LAN hubs are visible but untrusted.
   - Verify: Run two hubs where neither has the other's public key authorized.
   - Pass: Each can show the other as discovered/untrusted and cannot exchange messages or list remote agents.
   - Fail: Unknown hubs can send prompts, list agents, or open messaging channels.

4. [ ] Authorized hubs can complete Ed25519 challenge-response authentication.
   - Verify: Add the remote hub public key to `authorized_keys`, connect over `wss://`, and perform handshake.
   - Pass: Valid signatures authenticate; invalid signatures, unknown keys, stale handshakes, and replayed nonces are rejected.
   - Fail: Unknown or replayed authentication succeeds.

5. [ ] Trusted hubs can send and await prompt responses.
   - Verify: Start two authorized hubs with one registered Pi instance each and send a prompt requiring a response.
   - Pass: Prompt is delivered only after trusted-key auth, response is returned, and both directions are audited.
   - Fail: Prompt bypasses auth, response correlation fails, or audit entries are missing.

6. [ ] Audit logging captures required events.
   - Verify: Trigger discovery, failed auth, successful auth, trust change, inbound message, and outbound message.
   - Pass: Each event type appears in `~/.pi/coms-lan/` audit logs with useful non-secret metadata.
   - Fail: Required events are missing or logs include secrets/private key material.

7. [ ] Project labels are generated from git context with fallback behavior.
   - Verify: Register Pi instances from a git worktree branch, a normal git repo, and a non-git directory.
   - Pass: Labels follow git worktree branch name when available and fall back to cwd basename with git branch when available.
   - Fail: Labels are empty, unstable, or leak unnecessary absolute path details.

## Alternatives Considered

| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Extend `coms-net.ts` | Reuses existing network comms shape | Risks breaking existing behavior and mixes security model into prior extension | Rejected for v1; build `coms-lan.ts` separately |
| One network listener per Pi instance | Simple direct mapping from agent to endpoint | Port conflicts, harder firewall/auth story, poor multi-instance UX | Rejected |
| One hub per machine | Avoids per-instance port conflicts, centralizes LAN auth, lets local Pi instances register | Requires local hub lifecycle and registration | Accepted |
| Full SWIM/memberlist in v1 | Strong membership/failure model | More complexity than needed for small LAN agent pools | Deferred |
| UDP broadcast discovery | Simple, matches Joyride prior art, cross-platform enough for LAN MVP | Broadcast behavior can vary by network | Accepted for v1 |
| mDNS discovery | Friendly service discovery model | More dependencies and platform behavior to validate | Deferred |
| Full SSH protocol via `ssh2` | Battle-tested SSH auth concepts | Heavy and mismatched with desired `wss://` transport | Rejected for v1 |
| `@noble/ed25519` plus narrow parser | Small crypto dependency, limited parser scope, clear tests | Requires maintaining a small OpenSSH wire parser | Preferred pending planning validation |
| `sshpk` for parsing | Existing OpenSSH/Ed25519 parser | Older dependency surface and broader feature set than needed | Possible fallback only |

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Incorrect authentication handshake design | Unauthorized command execution | Use nonce-bound signed payloads, deterministic canonicalization, tests for replay/unknown-key/invalid-signature cases |
| `authorized_keys` parsing edge cases | Valid keys rejected or malformed keys accepted | Support only `ssh-ed25519` in v1, reject unsupported options/types, use `ssh-keygen` fixtures |
| UDP broadcast blocked by network or firewall | Discovery does not work on some LANs | Keep static/manual endpoint configuration as a possible fallback during planning if needed |
| Self-signed TLS trust friction | WSS connection setup may be awkward | Use app-level key auth as the trust mechanism and document certificate handling clearly |
| Multiple local hubs race on startup | Port conflicts or split local registry | Use hub state file, health check, and lock file under `~/.pi/coms-lan/` |
| Prompt loops between trusted agents | Token/cost waste | Require message IDs, response correlation, TTL/hop limit, and audit logs |
| Sensitive data in discovery or audit logs | Credential or path leakage | Redact secrets, avoid raw cwd in discovery, log metadata not payload bodies unless explicitly needed |
| Dependency risk in crypto/auth libraries | Supply chain or runtime compatibility issues | Prefer minimal dependencies, verify Bun/Pi compatibility, pin versions, and test core paths |

## Resolved Questions

- V1 includes manual peer fallback through explicit remote tool parameters and
  persistent static peers in `~/.pi/coms-lan/config.json` when UDP broadcast is
  unavailable.
- Prompt and response payload bodies are omitted from audit logs by default.
- Trust changes are file-based through `~/.pi/coms-lan/authorized_keys`, with
  commands/tools for displaying the local public key line, showing the trust file
  path, and validating/deduping/appending public key lines.
- `authorized_keys` options are rejected outright for v1; only plain
  `ssh-ed25519` public key lines are accepted.
- WSS uses Node `https` plus `ws` for compatibility with the Pi extension
  runtime, with app-level Ed25519 authentication as the trust gate.
- V1 keeps the hub in-process inside the first Pi instance that wins the local
  hub lock; a spawned hub process is deferred as a post-v1 hardening option.

## Plan Handoff

- Recommended next command:
  ```bash
  /plan-it .specs/secure-lan-pi-coms/PRD.md
  ```
- Review command:
  ```bash
  /review-it .specs/secure-lan-pi-coms/PRD.md
  ```
- Notes for planner:
  - Read the Joyride Docker cluster files before designing UDP discovery.
  - Read `coms.ts` and `coms-net.ts` before defining the Pi tool surface.
  - Verify `@noble/ed25519` API shape and Pi/Bun compatibility before selecting it.
  - Verify whether a maintained parser is worth using before writing a custom `ssh-ed25519` parser.
  - Treat security behavior as acceptance-critical, not as a later hardening task.