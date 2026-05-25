---
created: 2026-05-22
status: active
---

# Onclave Usage

`Onclave` is a Pi extension for secure LAN discovery, explicit trust, and
prompt routing between Pi sessions.

This guide is the quickest way to get productive with the current v1 tool
surface. For deeper operational details, acceptance steps, and audit guidance,
see [ONCLAVE_OPERATOR_GUIDE.md](./ONCLAVE_OPERATOR_GUIDE.md) and
[ONCLAVE_MANUAL_ACCEPTANCE.md](./ONCLAVE_MANUAL_ACCEPTANCE.md).

## What Onclave Does

`Onclave` gives Pi a machine-level LAN communication layer with these core
behaviors:

- each machine runs one local hub that multiple Pi sessions reuse;
- hubs discover each other on the LAN over UDP broadcast;
- remote access is denied until hosts explicitly exchange `ssh-ed25519` public
  key lines;
- prompts and responses move over authenticated WSS connections;
- optional static peers let you work even when UDP broadcast is blocked.

## Loading the Extension

From this repository, the most direct way to load `Onclave` is with Pi's
`--extension` flag:

```bash
pi -e ./extensions/pi-onclave
```

If you want Pi to ignore other discovered extensions and load only this one:

```bash
pi --no-extensions -e ./extensions/pi-onclave
```

Pi also supports loading extensions from auto-discovered locations such as
`~/.pi/agent/extensions/` and `.pi/extensions/`, but `-e` is the simplest way
from a checkout of this repository.

### Pi Resource Flags Relevant to Onclave

| Flag | Meaning |
| --- | --- |
| `-e`, `--extension <source>` | Load `extensions/pi-onclave` directly |
| `--no-extensions` | Disable extension auto-discovery and load only explicitly provided extensions |

### Onclave Extension Flags

`Onclave` registers four CLI flags that can be passed when Pi starts.

| Flag | Type | Meaning |
| --- | --- | --- |
| `--name <text>` | string | Override the local agent display name |
| `--purpose <text>` | string | Describe what this agent is for |
| `--color <#RRGGBB>` | string | Set the local agent color shown in the widget |
| `--explicit` | boolean | Mark this agent as explicit for sessions where you do not want it shown in default listings |

Examples:

```bash
pi -e ./extensions/pi-onclave --name host-a
```

```bash
pi -e ./extensions/pi-onclave \
  --name reviewer \
  --purpose "Respond to remote review requests" \
  --color "#22c55e"
```

```bash
pi --no-extensions -e ./extensions/pi-onclave --explicit
```

## Quick Starts

### Single-Machine Quick Start

Use this when you want to verify that the local hub and local agent
registration work.

Start Pi with `Onclave` enabled:

```bash
pi -e ./extensions/pi-onclave --name local-a
```

Then run:

```text
onclave_status
onclave_agents
```

Open a second Pi session with the same extension:

```bash
pi -e ./extensions/pi-onclave --name local-b
```

Then run:

```text
onclave_agents
```

Expected result:

- the first session starts the local machine hub;
- the second session reuses it;
- `onclave_agents` shows both local sessions.

### Two-Host Quick Start

Use this when you want two trusted machines to talk over the LAN.

#### 1. Start Pi on both hosts

On Host A:

```bash
pi -e ./extensions/pi-onclave --name host-a
```

On Host B:

```bash
pi -e ./extensions/pi-onclave --name host-b
```

On both hosts, run:

```text
onclave_status
```

#### 2. Exchange trust

On Host A, run:

```text
onclave_trust_info
```

Copy the `ssh-ed25519 ...` line and add it on Host B:

```text
onclave_trust_add public_key_line="ssh-ed25519 ..."
```

Repeat in the other direction so trust is mutual.

Restart Pi sessions after changing trust.

#### 3. Confirm discovery

On either host, run:

```text
onclave_peers
```

You should see the peer with a trusted or authenticated state.

#### 4. List remote agents

From Host A, use Host B's current endpoint metadata from `onclave_status`:

```text
onclave_remote_agents endpoint="wss://HOST_B:PORT/v1/hub" node_id="node_..." hub_instance_id="hub_..."
```

#### 5. Send a remote prompt

```text
onclave_remote_send endpoint="wss://HOST_B:PORT/v1/hub" node_id="node_..." hub_instance_id="hub_..." target_session_id="REMOTE_SESSION_ID" prompt="Reply with: onclave ok"
```

By default, this uses `reply_mode="async_message"`, so the receiving host
should answer with `onclave_reply` rather than a normal polling flow.

### Static Peer Quick Start

If UDP discovery is blocked, add a static peer entry under:

```text
~/.pi/onclave/config.json
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

Then use the peer by name instead of repeating endpoint metadata:

```text
onclave_static_peers
onclave_remote_agents peer_name="bench"
onclave_remote_send peer_name="bench" target_session_id="REMOTE_SESSION_ID" prompt="Ping"
```

## Status Widget and Dot Meanings

When `Onclave` is active, Pi shows a peer widget below the editor. Each peer row
includes a status dot and a text state.

| Dot | Text state | Meaning |
| --- | --- | --- |
| Green `●` | `trusted/auth` | The peer is trusted and a remote authentication has completed successfully |
| Amber `◐` | `authing` | Authentication is currently in progress |
| Red `✗` | `auth_failed` | Authentication failed or the peer was marked as auth failed |
| Blue `●` | `trusted/seen` | The peer is trusted and has been discovered, but no authenticated remote request has completed yet |
| Gray `~` | `stale` | The peer record is stale |
| Magenta `◆` | `untrusted/seen` | The peer was discovered but is not trusted yet |

These states come from the peer trust and authentication state tracked by the
runtime.

## Tool Reference

### Trust and Status Tools

#### `/onclave-trust`

Interactive slash command that prints the local public key line and the local
`authorized_keys` path.

#### `onclave_trust_info`

Shows the local trust information.

Example:

```text
onclave_trust_info
```

Use it when you need the local `ssh-ed25519` line for a peer.

#### `onclave_trust_add`

Adds a trusted peer public key to `~/.pi/onclave/authorized_keys`.

Parameters:

- `public_key_line`: full `ssh-ed25519 ...` line from a peer

Example:

```text
onclave_trust_add public_key_line="ssh-ed25519 AAAA... host-b"
```

#### `onclave_status`

Shows the current hub endpoint, whether this session started the hub, the local
node ID, the current hub instance ID, the public key line, and LAN-usable
remote endpoint hints.

Example:

```text
onclave_status
```

Use `node_id`, `hub_instance_id`, and one of the printed `remote_endpoints`
when calling remote tools explicitly.

#### `onclave_peers`

Lists discovered LAN peers plus static peers from config.

Example:

```text
onclave_peers
```

Look for these fields in discovered peers:

- `node_id`
- `hub_instance_id`
- `endpoint`
- `trust_state`
- `auth_state`
- `last_seen_at`

#### `onclave_static_peers`

Lists persistent peers from `~/.pi/onclave/config.json`.

Example:

```text
onclave_static_peers
```

### Local Agent Tools

#### `onclave_agents`

Lists local agents registered with the current machine hub.

Example:

```text
onclave_agents
```

#### `onclave_send`

Sends a prompt to a local session by `target_session_id`.

Parameters:

- `target_session_id`
- `prompt`

Example:

```text
onclave_send target_session_id="session-id" prompt="Summarize your branch"
```

The result includes a `msg_id` for response retrieval.

#### `onclave_get`

Polls a previously sent local message by `msg_id`.

Parameters:

- `msg_id`

Example:

```text
onclave_get msg_id="msg_..."
```

#### `onclave_await`

Waits for a local response until the timeout expires.

Parameters:

- `msg_id`
- `timeout_ms` (optional, default `30000`)

Example:

```text
onclave_await msg_id="msg_..." timeout_ms=30000
```

### Remote Agent Tools

These tools require either:

- `peer_name`, or
- all of `endpoint`, `node_id`, and `hub_instance_id`

#### `onclave_remote_agents`

Lists agents available from a trusted remote hub.

Examples:

```text
onclave_remote_agents peer_name="bench"
```

```text
onclave_remote_agents endpoint="wss://host:4444/v1/hub" node_id="node_..." hub_instance_id="hub_..."
```

#### `onclave_remote_send`

Sends a prompt to a trusted remote agent.

Parameters:

- `peer_name` or explicit endpoint metadata
- `target_session_id`
- `prompt`
- `reply_mode` (optional: `async_message` or `pollable`)

Default behavior uses `async_message`.

Examples:

```text
onclave_remote_send peer_name="bench" target_session_id="session-id" prompt="Reply with your hostname"
```

```text
onclave_remote_send peer_name="bench" target_session_id="session-id" prompt="Return a one-line summary" reply_mode="pollable"
```

#### `onclave_remote_get`

Polls a remote response for requests that were sent with
`reply_mode="pollable"`.

Parameters:

- `peer_name` or explicit endpoint metadata
- `msg_id`

Example:

```text
onclave_remote_get peer_name="bench" msg_id="msg_..."
```

Do not use this for the default async reply path.

#### `onclave_reply`

Sends an asynchronous reply back to the origin host for an inbound
`async_message` prompt.

Parameters:

- `msg_id` (optional; defaults to the latest replyable inbound message)
- `response`
- `status` (optional: `completed`, `failed`, `needs_input`)

Example:

```text
onclave_reply response="onclave ok" status="completed"
```

Use this only when the inbound message explicitly tells you to use
`onclave_reply`.

## Common Examples

### Load Onclave for a named responder session

```bash
pi -e ./extensions/pi-onclave \
  --name responder \
  --purpose "Handle inbound Onclave prompts" \
  --color "#3b82f6"
```

### Start clean with only this extension

```bash
pi --no-extensions -e ./extensions/pi-onclave --name host-a
```

### Trust a peer after it sends you its key

```text
onclave_trust_add public_key_line="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA... host-b"
```

### Send to a local agent and wait for completion

```text
onclave_send target_session_id="session-id" prompt="Summarize your current work"
onclave_await msg_id="msg_..." timeout_ms=30000
```

### Send to a static remote peer

```text
onclave_remote_agents peer_name="bench"
onclave_remote_send peer_name="bench" target_session_id="REMOTE_SESSION_ID" prompt="Reply with: ready"
```

### Send a pollable remote request

```text
onclave_remote_send peer_name="bench" target_session_id="REMOTE_SESSION_ID" prompt="Return JSON status" reply_mode="pollable"
onclave_remote_get peer_name="bench" msg_id="msg_..."
```

## Common Mistakes to Avoid

- Do not call `onclave_remote_get` for the default async reply flow. Use it only
  for `reply_mode="pollable"` sends.
- Do not trust a peer based only on discovery. Discovery shows that a hub is
  present, not that it is authorized.
- Do not copy private key files between machines.
- Do not forget to restart Pi sessions after changing trust.
- Do not use endpoints that omit `/v1/hub`. Static peers and remote tools expect
  `wss://.../v1/hub`.

## Related Documents

- [README.md](../README.md)
- [ONCLAVE_OPERATOR_GUIDE.md](./ONCLAVE_OPERATOR_GUIDE.md)
- [ONCLAVE_MANUAL_ACCEPTANCE.md](./ONCLAVE_MANUAL_ACCEPTANCE.md)
- [ONCLAVE_DECISIONS.md](./ONCLAVE_DECISIONS.md)
- [STATUS.md](./STATUS.md)
