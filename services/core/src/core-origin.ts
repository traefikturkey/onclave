import { hostname } from "node:os";
import type { A2AOrigin } from "@onclave/envelope";

export const CORE_AGENT_ID = "onclave-core";

export function coreOrigin(): A2AOrigin {
  return { instance_id: CORE_AGENT_ID, name: "Onclave Core", host: hostname() };
}
