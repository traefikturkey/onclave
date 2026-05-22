---
description: Run the host-a initiator side of the Onclave LAN acceptance test
---
Run the host-a initiator side of the Onclave LAN acceptance test.

Steps:

1. Run `onclave_status`, `onclave_peers`, and `onclave_agents`.
2. From `onclave_peers`, pick the live discovered peer for host-b and capture
   its current `endpoint`, `node_id`, and `hub_instance_id`. Do not rely on
   stale historical IDs.
3. Run `onclave_remote_agents` using that live discovered peer metadata.
4. From the remote agent details, choose the first agent with `status`
   `"online"` and capture its `sessionId`.
5. Run `onclave_remote_send` to that `sessionId` with this exact prompt:
   `Reply with exactly: onclave acceptance ok`
   Use the default async reply mode. Do not set `reply_mode="pollable"`.
6. Do not call `onclave_remote_get`. Stop and wait for the inbound Onclave
   reply message from host-b.
7. Return a compact report with:
    - local node id
    - remote endpoint used
    - remote node id used
    - remote hub instance id used
    - remote target session id
    - msg id
    - whether the async reply arrived
    - reply text
8. If any step fails, stop and report the exact failing tool call and error.

Do not ask the user for values that are already available from tool output.
Use the live discovered endpoint instead of hard-coded ports.
