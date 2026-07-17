import { describe, expect, it, vi } from "vitest";
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
});
