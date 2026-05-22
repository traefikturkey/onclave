---
description: Prepare host-b as the responder side of the Onclave LAN acceptance test
---
Run the host-b responder side of the Onclave LAN acceptance test.

Steps:

1. Run `onclave_status`, `onclave_peers`, and `onclave_agents`.
2. From `onclave_peers`, capture the live discovered peer metadata for host-a
   if present. If the discovered peer IDs differ from any previously recorded
   values, treat the live discovered metadata as authoritative and report that
   the older values are stale.
3. From the local agent details, capture the first local `sessionId` that is
   available to receive inbound prompts.
4. Do not send any outbound Onclave message in this turn.
5. Return a compact ready report with:
    - local node id
    - local hub endpoint
    - first local session id
    - discovered host-a endpoint
    - discovered host-a node id, if present
6. After the ready report, stay idle in this session. When an inbound
   Onclave message arrives later:
    - if it says to use `onclave_reply`, use `onclave_reply`
    - if it says to reply with a normal assistant response, do not call
      `onclave_reply`; answer normally instead
    - do not add extra narration

Do not ask the user for values that are already available from tool output.
Use the live discovered endpoint instead of hard-coded ports.
