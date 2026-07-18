import { hostname } from "node:os";
import type { AgentOrigin } from "@onclave/envelope";

export const CORE_AGENT_ID = "onclave-core";

export function coreOrigin(): AgentOrigin {
  return { agent_id: CORE_AGENT_ID, name: "Onclave Core", host: hostname() };
}
