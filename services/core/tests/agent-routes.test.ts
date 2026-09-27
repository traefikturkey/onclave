import { describe, expect, it, vi } from "vitest";
import { createAgentRouteHandlers } from "../src/vault/agent-routes";
import type { RouteRequest, RouteResponse } from "../src/vault/http";

function request(): RouteRequest {
  return { params: {}, query: { agent_id: "agent-a", wait_ms: "25000" }, body: Buffer.alloc(0), keyId: "key-a" };
}

describe("authenticated agent delivery polls", () => {
  it("renews presence and returns current live peer count on an empty long poll", async () => {
    const heartbeat = vi.fn(async () => true);
    const next = vi.fn(async () => undefined);
    const handlers = createAgentRouteHandlers({
      services: { registry: { get: () => ({ agent_id: "agent-a", key_id: "key-a" }), heartbeat, list: () => [
        { agent_id: "agent-a", alive: true },
        { agent_id: "agent-b", alive: true },
      ] } } as never,
      channel: () => ({}) as never,
      deliveries: { next } as never,
    });

    const response = await handlers.agentsMessagesNext?.(request()) as RouteResponse;
    expect(heartbeat).toHaveBeenCalledWith("agent-a");
    expect(next).toHaveBeenCalledWith("agent-a", "key-a", 25_000);
    expect(response).toMatchObject({ raw: "", status: 204, headers: { "x-onclave-live-peers": "1" } });
  });

  it("returns peer count alongside a delivered message", async () => {
    const handlers = createAgentRouteHandlers({
      services: { registry: { get: () => ({ agent_id: "agent-a", key_id: "key-a" }), heartbeat: vi.fn(async () => true), list: () => [{ agent_id: "agent-a", alive: true }, { agent_id: "agent-b", alive: true }] } } as never,
      channel: () => ({}) as never,
      deliveries: { next: vi.fn(async () => ({ deliveryId: "delivery-1", kind: "task-status", status: { event_id: "event-1" } })) } as never,
    });

    const response = await handlers.agentsMessagesNext?.(request()) as RouteResponse;
    expect(response).toMatchObject({ json: { delivery_id: "delivery-1", kind: "task-status" }, headers: { "x-onclave-live-peers": "1" } });
  });
});
