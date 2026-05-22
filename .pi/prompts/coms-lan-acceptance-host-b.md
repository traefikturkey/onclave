---
description: Prepare host-b as the responder side of the coms-lan LAN acceptance test
---
Run the host-b responder side of the coms-lan LAN acceptance test.

Known peer metadata for host-a:
- node_id: `node_01KS70KHJ5A8CQWBKE28X6PZXM`
- hub_instance_id: `hub_01KS70KHJ5A8CQWBKE28X6PZXM`

Steps:

1. Run `coms_lan_status`, `coms_lan_peers`, and `coms_lan_agents`.
2. From `coms_lan_peers` tool details, confirm host-a is discovered by
   `node_id` and capture its current `endpoint`.
3. From the local agent details, capture the first local `sessionId` that is
   available to receive inbound prompts.
4. Do not send any outbound coms-lan message in this turn.
5. Return a compact ready report with:
    - local node id
    - local hub endpoint
    - first local session id
    - discovered host-a endpoint
6. After the ready report, stay idle in this session. When an inbound
   coms-lan message arrives later, reply exactly as requested and do not add
   extra narration.

Do not ask the user for values that are already available from tool details.
Use the discovered endpoint instead of hard-coded ports.
