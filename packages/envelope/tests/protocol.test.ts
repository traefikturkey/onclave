import { describe, expect, it } from "vitest";
import { isAgentCard, parseRpcRequest } from "../src/protocol";

const card = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "host-a",
  transport: "https",
};

describe("AgentCard transport", () => {
  it("accepts HTTPS agent cards for signed HTTP adapters", () => {
    expect(isAgentCard(card)).toBe(true);
    expect(parseRpcRequest({ op: "register", protocol_version: 1, card })).toEqual({
      ok: true,
      request: { op: "register", protocol_version: 1, card },
    });
  });

  it("keeps AMQP compatibility and rejects unknown transports", () => {
    expect(isAgentCard({ ...card, transport: "amqp" })).toBe(true);
    expect(isAgentCard({ ...card, transport: "wss" })).toBe(false);
  });

  it("parses live-only and diagnostic agent listings", () => {
    expect(parseRpcRequest({ op: "list_agents" })).toEqual({
      ok: true,
      request: { op: "list_agents" },
    });
    expect(parseRpcRequest({ op: "list_agents", include_stale: true })).toEqual({
      ok: true,
      request: { op: "list_agents", include_stale: true },
    });
    expect(parseRpcRequest({ op: "list_agents", include_stale: "yes" })).toEqual({
      ok: false,
      error: "list_agents include_stale must be a boolean",
    });
  });
});
