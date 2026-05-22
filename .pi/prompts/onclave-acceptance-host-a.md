---
description: Run the host-a initiator side of the Onclave LAN acceptance test
---
Run the host-a initiator side of the Onclave LAN acceptance test.

Known peer metadata for host-b:
- node_id: `node_01KS7Z18TS7RPK0J51PYDKDJT8`
- hub_instance_id: `hub_01KS7Z18TS7RPK0J51PYDKDJT8`

Steps:

1. Run `onclave_status`, `onclave_peers`, and `onclave_agents`.
2. From `onclave_peers` tool details, find the discovered peer for host-b
   by `node_id` and capture its current `endpoint`.
3. Run `onclave_remote_agents` using that discovered endpoint and the known
   host-b `node_id` and `hub_instance_id`.
4. From the remote agent details, choose the first agent with `status`
   `"online"` and capture its `sessionId`.
5. Run `onclave_remote_send` to that `sessionId` with this exact prompt:
   `Reply with exactly: onclave acceptance ok`
6. Poll `onclave_remote_get` until the message is no longer pending, waiting
   up to 30 seconds total.
7. Return a compact report with:
    - local node id
    - remote endpoint used
    - remote target session id
    - msg id
    - final status
    - response text
8. If any step fails, stop and report the exact failing tool call and error.

Do not ask the user for values that are already available from tool details.
Use the discovered endpoint instead of hard-coded ports.
