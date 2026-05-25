---
created: 2026-05-21
status: active
source_prd: ./PRD.md
---

# Onclave Manual LAN Acceptance

This runbook covers the manual multi-host checks that cannot be fully proven by
single-machine unit/integration tests.

Manual status:

- 2026-05-22: executed successfully on two physical hosts on the same subnet.
- Discovery, trust exchange, trusted remote list/send/get, and audit scans all
  passed.

## Prerequisites

- Two machines on the same LAN, referred to as **Host A** and **Host B**.
- Pi installed with the `extensions/pi-onclave` extension available on both
  machines.
- Firewalls allow UDP broadcast on the discovery port and inbound TCP for the
  selected WSS hub port.
- No private key material is copied between hosts.
- Trust is established only by exchanging public key lines from
  `onclave_trust_info` or `/onclave-trust`.

Default discovery port: `48889/udp`.

## Safety Rules

- Do not copy or edit private keys.
- Do not use keys from `~/.ssh/`.
- Only copy public `ssh-ed25519 ...` lines printed by the trust info command or
  tool.
- Do not paste prompt or response bodies into audit logs or trust files.

## Helper Script

From this repository on each host, run:

```bash
bun run onclave:acceptance-host -- --host-name host-a
```

Run it once before starting Pi to create the local Onclave identity and print
this host's public key line. Then start Pi, run `onclave_status`, and rerun the
helper to print local endpoint/IDs and suggested Pi tool calls. If the hub line
says `not started yet` on the first run, that is expected.

After collecting peer endpoint metadata, you can write a static peer entry:

```bash
bun run onclave:acceptance-host -- \
  --host-name host-a \
  --peer-name host-b \
  --peer-node-id node_... \
  --peer-hub-instance-id hub_... \
  --peer-endpoint wss://HOST_B_IP:PORT/v1/hub \
  --write-static-peer
```

## Check 1: One Local Hub per Machine

1. Start one Pi session with `Onclave` enabled on Host A.
2. Run `onclave_status`.
3. Start a second Pi session with `Onclave` enabled on Host A.
4. Run `onclave_status` in the second session.
5. Run `onclave_agents` from either session.

Expected result:

- The first session reports `started_here: true`.
- The second session reports `started_here: false`.
- Both sessions show the same hub endpoint and hub instance ID.
- `onclave_agents` lists both local agents.

## Check 2: Discovery Packets Are Metadata Only

1. Start one Pi session with `Onclave` enabled.
2. Capture or inspect a UDP discovery packet on port `48889`.
3. Confirm the packet fields match the allowed discovery shape.

Allowed fields:

- `m`
- `v`
- `node_id`
- `hub_instance_id`
- `wss_port`
- `started_at`

Expected result:

- No prompt body.
- No response body.
- No token, credential, or private key material.
- No raw current working directory or local filesystem path.
- Endpoint host is derived from the UDP sender address, not sent with secrets.

## Check 3: Unknown LAN Hubs Are Visible but Untrusted

1. Start one Pi session with `Onclave` enabled on Host A.
2. Start one Pi session with `Onclave` enabled on Host B.
3. Do not exchange public keys yet.
4. Run `onclave_peers` on both hosts.
5. Attempt a remote list or remote send using the other host endpoint and IDs.

Expected result:

- Each host can show the other as discovered when UDP broadcast is available.
- Discovered peers are `untrusted` before key exchange.
- Remote list/send does not succeed before the remote public key is present in
  `~/.pi/onclave/authorized_keys`.

## Check 4: Exchange Public Keys

1. On Host A, run `onclave_trust_info` or `/onclave-trust`.
2. Copy Host A's public `ssh-ed25519 ...` line.
3. Append that line to Host B's `~/.pi/onclave/authorized_keys`.
4. On Host B, run `onclave_trust_info` or `/onclave-trust`.
5. Copy Host B's public `ssh-ed25519 ...` line.
6. Append that line to Host A's `~/.pi/onclave/authorized_keys`, or use
   `onclave_trust_add` on Host A.
7. Restart both Pi sessions, or start new sessions, so the trust file is loaded.

Expected result:

- Trust files contain only public `ssh-ed25519` lines.
- Unsupported key types or `authorized_keys` options are not used.

## Check 5: Trusted Remote Agent Listing

1. On Host A, run `onclave_status` and record Host A's endpoint, node ID, and
   hub instance ID.
2. On Host B, run `onclave_status` and record Host B's endpoint, node ID, and
   hub instance ID.
3. From Host A, call `onclave_remote_agents` with Host B's endpoint, node ID,
   and hub instance ID, or with a `peer_name` configured in Host A's
   `config.json`.
4. From Host B, call `onclave_remote_agents` with Host A's endpoint, node ID,
   and hub instance ID, or with a `peer_name` configured in Host B's
   `config.json`.

Expected result:

- Each host lists the other host's registered agents only after key exchange.
- Authentication failures appear when IDs or signatures are invalid.

## Check 6: Trusted Remote Send/Get

1. Use `onclave_remote_agents` to choose a remote target session ID.
2. Call `onclave_remote_send` with the trusted remote endpoint, node ID, hub
   instance ID, target session ID, and a harmless test prompt.
3. Record the returned message ID.
4. By default, wait for the remote session to reply asynchronously with a new
   inbound Onclave message. Do not poll `onclave_remote_get` for this default
   async path.
5. Only call `onclave_remote_get` when the original send explicitly used
   `reply_mode="pollable"`.

Expected result:

- Prompt delivery succeeds only after trusted-key authentication.
- The default async path returns through a new inbound Onclave reply.
- The pollable path correlates to the returned message ID when used.
- Unknown message IDs return a non-success lookup result.

## Check 7: Audit Log Review

Inspect `~/.pi/onclave/audit.log.jsonl` on each host after the checks.

Expected metadata:

- local registration and unregister events.
- inbound/outbound message metadata.
- response metadata.
- authentication and discovery events where currently wired.

Forbidden content:

- prompt bodies.
- response bodies.
- private signing keys.
- TLS private keys.
- credentials, tokens, or passwords.

## Check 8: Owner Exit and Recovery

1. Identify which local Pi session started the hub.
2. Close that session.
3. Start another Pi session on the same host.
4. Run `onclave_status` and `onclave_agents`.

Expected result:

- Stale hub state is replaced when the prior hub is no longer live.
- A new hub starts without fixed-port conflicts.
- The new session registers successfully.

## Recording Results

For each host, record:

- OS and shell.
- Pi version.
- Local endpoint from `onclave_status`.
- Whether UDP discovery succeeded.
- Whether explicit remote tools succeeded.
- Any firewall or network changes required.

Do not record prompt or response body content in the acceptance notes.
