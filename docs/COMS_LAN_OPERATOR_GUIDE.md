---
created: 2026-05-21
status: active
source_prd: ./PRD.md
---

# COMS LAN Operator Guide

`coms-lan` lets Pi sessions on a LAN discover local machine hubs, explicitly
trust remote hubs with Ed25519 public keys, and exchange prompt/response
messages over authenticated WSS.

## State Location

All runtime state lives under:

```text
~/.pi/coms-lan/
```

Important files:

```text
authorized_keys      # trusted peer public ssh-ed25519 lines
config.json          # optional non-secret static peer config
audit.log.jsonl      # metadata-only audit log
hub.json             # current local hub endpoint/state
identity.json        # local node identity and public key metadata
identity.key         # app-specific private signing key; do not copy
tls.cert.pem         # local self-signed TLS certificate
tls.key.pem          # local TLS private key; do not copy
```

Do not copy private key files between machines. Do not use or modify private
keys under `~/.ssh/` for this system.

## Acceptance Helper Script

From this repository on each host, run:

```bash
bun run coms-lan:acceptance-host -- --host-name host-a
```

The helper creates the local coms-lan identity if needed, then prints:

- local identity and hub state when available
- the public key line to copy to the peer
- `coms_lan_trust_add` command for the peer
- endpoint, node ID, and hub instance ID values for remote tools
- suggested Pi tool commands for the acceptance flow

If the hub line says `not started yet`, that is expected before the first Pi
session starts `coms-lan`. Start Pi, run `coms_lan_status`, then rerun the
helper to print endpoint metadata.

After you know the peer's endpoint and IDs, you can also write a static peer:

```bash
bun run coms-lan:acceptance-host -- \
  --host-name host-a \
  --peer-name host-b \
  --peer-node-id node_... \
  --peer-hub-instance-id hub_... \
  --peer-endpoint wss://HOST_B_IP:PORT/v1/hub \
  --write-static-peer
```

Optional audit check:

```bash
bun run coms-lan:acceptance-host -- --audit-scan
```

## Project Prompt Templates

This repository includes two project prompt templates under `.pi/prompts/` to
reduce manual copy/paste during LAN acceptance runs:

- `/coms-lan-acceptance-host-b` prepares Host B as the responder and surfaces
  its local `sessionId` from tool details.
- `/coms-lan-acceptance-host-a` discovers Host B from `coms_lan_peers`, picks a
  remote `sessionId` from `coms_lan_remote_agents`, sends the acceptance prompt,
  and polls for the response.

Recommended order:

1. Open Pi with `extensions/coms-lan.ts` on Host B and run
   `/coms-lan-acceptance-host-b`.
2. Open Pi with `extensions/coms-lan.ts` on Host A and run
   `/coms-lan-acceptance-host-a`.

The templates are intentionally asymmetric so Host B stays available to answer
Host A's inbound test prompt instead of both hosts blocking on outbound waits.

## First Run

Start Pi with the `extensions/coms-lan.ts` extension enabled.

The first local Pi session starts the machine hub. Later local Pi sessions reuse
that live hub and register as local agents.

Use:

```text
coms_lan_status
```

Expected fields:

- hub endpoint
- whether this session started the hub
- local public key line for peer trust setup
- optional `remote_endpoints` hints derived from non-loopback local interfaces

## Trust Exchange

On each host, run either:

```text
/coms-lan-trust
```

or:

```text
coms_lan_trust_info
```

Copy only the printed public line that begins with `ssh-ed25519`.

On the peer host, add it with either:

```text
coms_lan_trust_add public_key_line="ssh-ed25519 ..."
```

or by manually appending it to:

```text
~/.pi/coms-lan/authorized_keys
```

Restart affected Pi sessions after changing trust so the runtime reloads the
trust file.

## Discovery

Use:

```text
coms_lan_peers
```

This reports:

- discovered UDP peers from the LAN
- static peers from `config.json`

Discovery packets contain only metadata:

- protocol marker
- version
- node ID
- hub instance ID
- WSS port
- start timestamp

They do not include prompts, responses, cwd, tokens, private keys, or local
paths.

## Static Peers

Static peers are optional and useful when UDP broadcast is blocked. Create or
edit:

```text
~/.pi/coms-lan/config.json
```

Example:

```json
{
  "version": 1,
  "staticPeers": [
    {
      "name": "bench",
      "nodeId": "node_...",
      "hubInstanceId": "hub_...",
      "endpoint": "wss://192.168.1.20:4444/v1/hub"
    }
  ]
}
```

List configured static peers:

```text
coms_lan_static_peers
```

Remote tools accept either a `peer_name` from static config or explicit
`endpoint`, `node_id`, and `hub_instance_id` parameters.

## Local Agent Messaging

List local agents:

```text
coms_lan_agents
```

Send to a local agent:

```text
coms_lan_send target_session_id="session-id" prompt="..."
```

Poll a response:

```text
coms_lan_get msg_id="msg_..."
```

Wait for a response:

```text
coms_lan_await msg_id="msg_..." timeout_ms=30000
```

## Trusted Remote Messaging

List remote agents with explicit peer metadata:

```text
coms_lan_remote_agents endpoint="wss://host:port/v1/hub" node_id="node_..." hub_instance_id="hub_..."
```

Or with a configured static peer:

```text
coms_lan_remote_agents peer_name="bench"
```

Send to a remote agent:

```text
coms_lan_remote_send peer_name="bench" target_session_id="session-id" prompt="..."
```

Poll the remote response:

```text
coms_lan_remote_get peer_name="bench" msg_id="msg_..."
```

Remote list/send/get requires successful Ed25519 authentication against the
remote host's `authorized_keys`. Endpoint knowledge alone does not grant access.

## Audit Logs

Audit log path:

```text
~/.pi/coms-lan/audit.log.jsonl
```

Audit entries are JSONL metadata. They intentionally omit prompt and response
bodies.

Expected event families include:

- hub start/stop
- trust loaded/changed
- local register/unregister
- discovery seen/ignored
- auth attempt/success/failure
- message inbound/outbound
- response inbound/outbound where applicable

Do not paste sensitive prompt or response content into manual audit notes.

## Troubleshooting

### Peers do not appear in discovery

- Confirm both hosts are on the same LAN/broadcast domain.
- Confirm UDP port `48889` is allowed by host firewalls.
- Use static peers in `config.json` if UDP broadcast is blocked.

### Remote list/send fails

- Confirm both hosts exchanged public `ssh-ed25519` lines.
- Confirm keys were added to `~/.pi/coms-lan/authorized_keys` on the receiving
  host.
- Restart sessions after trust changes.
- Confirm endpoint uses `wss://.../v1/hub`.
- Confirm node ID and hub instance ID match current `coms_lan_status` output.

### Local hub appears stale

Start a new Pi session. The bootstrap flow health-checks `hub.json` and replaces
stale state when the old owner process is gone.
