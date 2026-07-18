import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { OnclaveGatewayClient, OnclaveGatewayError } from "../src/lib/gateway-adapter";

describe("OnclaveGatewayClient", () => {
  it("authenticates and submits commands with the session bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: "session-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-1", state: "accepted" }), { status: 202 }));
    const client = new OnclaveGatewayClient({ baseUrl: "https://gateway.example/", fetchImpl });

    const token = await client.authenticate("agent/one", "signature");
    const task = await client.submitCommand(token, {
      messageId: "message-1",
      taskId: "task-1",
      correlationId: "correlation-1",
      sourceAgentId: "agent/one",
      targetAgentId: "agent/two",
      type: "task.assign",
      expiresAt: "2026-07-17T12:05:00.000Z",
      payload: { instruction: "test" },
    });

    expect(token).toBe("session-token");
    expect(task.state).toBe("accepted");
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://gateway.example/v1/agents/agent%2Fone/authenticate", expect.objectContaining({ method: "POST" }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://gateway.example/v1/commands", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer session-token" }),
    }));
  });

  it("surfaces gateway HTTP errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("forbidden", { status: 403 }));
    const client = new OnclaveGatewayClient({ baseUrl: "https://gateway.example", fetchImpl });

    await expect(client.getTask("bad-token", "task-1")).rejects.toEqual(new OnclaveGatewayError(403, "forbidden"));
  });

  it("signs a gateway challenge with the configured private key", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ nonce: Buffer.from("nonce").toString("base64") }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sessionToken: "session-token" }), { status: 200 }));
    const client = new OnclaveGatewayClient({ baseUrl: "https://gateway.example", fetchImpl });

    await expect(client.authenticateWithPrivateKey("agent-1", "11".repeat(32))).resolves.toBe("session-token");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("negotiates the requested capabilities after authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ requestId: "request-1", nonce: "nonce-1" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ capabilities: ["message.receive"] }), { status: 200 }));
    const client = new OnclaveGatewayClient({ baseUrl: "https://gateway.example", fetchImpl });

    const request = await client.requestCapabilities("session-token", "agent-1");
    const effective = await client.acceptCapabilities("session-token", "agent-1", request, ["message.receive"]);

    expect(effective).toEqual(["message.receive"]);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://gateway.example/v1/agents/agent-1/capabilities/request", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer session-token" }),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://gateway.example/v1/agents/agent-1/capabilities", expect.objectContaining({
      body: JSON.stringify({ requestId: "request-1", nonce: "nonce-1", capabilities: ["message.receive"] }),
    }));
  });

  it("cancels a task and reads the resulting state", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ taskId: "task-1", state: "cancelled" }), { status: 200 }));
    const client = new OnclaveGatewayClient({ baseUrl: "https://gateway.example", fetchImpl });

    await expect(client.cancelTask("session-token", "task-1", "No longer needed")).resolves.toMatchObject({
      taskId: "task-1",
      state: "cancelled",
    });
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://gateway.example/v1/tasks/task-1/cancel", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ reason: "No longer needed" }),
    }));
  });

  it("rejects non-HTTPS gateway URLs", () => {
    expect(() => new OnclaveGatewayClient({ baseUrl: "http://gateway.example" })).toThrow("HTTPS");
    expect(() => new OnclaveGatewayClient({ baseUrl: "https://user:pass@gateway.example" })).toThrow("credentials");
  });

  it("supports an agent-scoped event subscription when opening a session", () => {
    class FakeWebSocket {
      static lastUrl = "";
      on() { return this; }
      constructor(url: string) { FakeWebSocket.lastUrl = url; }
    }
    const client = new OnclaveGatewayClient({
      baseUrl: "https://gateway.example",
      webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    });

    client.connectSession("agent-1", "session-token", () => {}, { events: "task.completed.agent-1" });

    expect(FakeWebSocket.lastUrl).toBe("wss://gateway.example/v1/agents/agent-1/session?events=task.completed.agent-1");
  });
});
