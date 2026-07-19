import { describe, expect, it } from "vitest";
import { LocalAgentRegistry } from "../src/lib/local-registry";
import {
  MessageRouter,
  type DeliveredPrompt,
  type MessageResponse,
} from "../src/lib/messages";
import type { SendPromptFrame } from "../src/lib/transport";

const NOW = "2026-05-21T00:00:00.000Z";

describe("MessageRouter", () => {
  it("delivers prompts to registered local agents", async () => {
    const delivered: DeliveredPrompt[] = [];
    const router = createRouter(delivered);

    const result = await router.sendPrompt(createFrame());

    expect(result).toEqual({ ok: true, msgId: "msg-1", status: "delivered" });
    expect(delivered).toEqual([
      {
        msgId: "msg-1",
        targetSessionId: "session-1",
        deliveryEndpoint: "local://session-1",
        prompt: "hello",
        hops: 0,
        receivedAt: NOW,
      },
    ]);
    expect(router.getMessage("msg-1")?.status).toBe("delivered");
  });

  it("rejects prompts for unknown target sessions", async () => {
    const router = createRouter([]);

    const result = await router.sendPrompt(createFrame({ targetSessionId: "missing" }));

    expect(result).toEqual({ ok: false, error: "target_not_found" });
  });

  it("rejects prompts that exceed the hop limit", async () => {
    const router = createRouter([]);

    const result = await router.sendPrompt(createFrame({ hops: 5 }));

    expect(result).toEqual({ ok: false, error: "hop_limit_exceeded" });
  });

  it("returns pending status before a response is complete", async () => {
    const router = createRouter([]);
    await router.sendPrompt(createFrame());

    expect(router.getResponse("msg-1")).toEqual({ status: "pending" });
  });

  it("preserves async reply metadata when delivering prompts", async () => {
    const delivered: DeliveredPrompt[] = [];
    const router = createRouter(delivered);

    await router.sendPrompt(
      createFrame({
        replyMode: "async_message",
        origin: {
          nodeId: "node_origin",
          hubInstanceId: "hub_origin",
          endpoint: "wss://203.0.113.50:43837/v1/hub",
          sessionId: "session-origin",
          correlationId: "corr-1",
          agentName: "host-a",
          projectLabel: "onclave@main",
        },
      })
    );

    expect(delivered).toEqual([
      {
        msgId: "msg-1",
        targetSessionId: "session-1",
        deliveryEndpoint: "local://session-1",
        prompt: "hello",
        hops: 0,
        receivedAt: NOW,
        replyMode: "async_message",
        origin: {
          nodeId: "node_origin",
          hubInstanceId: "hub_origin",
          endpoint: "wss://203.0.113.50:43837/v1/hub",
          sessionId: "session-origin",
          correlationId: "corr-1",
          agentName: "host-a",
          projectLabel: "onclave@main",
        },
      },
    ]);
    expect(router.getMessage("msg-1")).toMatchObject({
      replyMode: "async_message",
      origin: { correlationId: "corr-1", sessionId: "session-origin" },
    });
  });

  it("correlates responses by message ID", async () => {
    const router = createRouter([]);
    await router.sendPrompt(createFrame());
    const response: MessageResponse = {
      msgId: "msg-1",
      responderSessionId: "session-1",
      response: "done",
      error: null,
      completedAt: "2026-05-21T00:00:05.000Z",
    };

    expect(router.submitResponse(response)).toEqual({ ok: true, status: "complete" });
    expect(router.getMessage("msg-1")).toMatchObject({
      msgId: "msg-1",
      status: "complete",
      response: "done",
      error: null,
      completedAt: "2026-05-21T00:00:05.000Z",
    });
    expect(router.getResponse("msg-1")).toEqual({
      status: "complete",
      response: "done",
      error: null,
    });
  });

  it("returns an error for responses to unknown messages", () => {
    const router = createRouter([]);

    expect(
      router.submitResponse({
        msgId: "missing",
        responderSessionId: "session-1",
        response: "done",
        error: null,
        completedAt: NOW,
      })
    ).toEqual({ ok: false, error: "message_not_found" });
  });

  it("marks expired messages as timeout", async () => {
    const router = createRouter([]);
    await router.sendPrompt(createFrame());

    const expired = router.cleanupExpired("2026-05-21T00:01:01.000Z");

    expect(expired).toEqual(["msg-1"]);
    expect(router.getMessage("msg-1")).toMatchObject({
      msgId: "msg-1",
      status: "timeout",
      error: "timeout",
    });
    expect(router.getResponse("msg-1")).toEqual({ status: "timeout", error: "timeout" });
  });
});

function createRouter(delivered: DeliveredPrompt[]): MessageRouter {
  const registry = new LocalAgentRegistry({ staleAfterMs: 30_000, offlineAfterMs: 60_000 });
  registry.register(
    {
      sessionId: "session-1",
      instanceId: "pi-instance-1",
      name: "agent-one",
      projectLabel: "onclave@main",
      model: "test-model",
      purpose: "testing",
      color: "#336699",
      explicit: false,
      deliveryEndpoint: "local://session-1",
    },
    NOW
  );

  return new MessageRouter({
    registry,
    now: () => NOW,
    ttlMs: 60_000,
    maxHops: 5,
    deliverPrompt: async (prompt) => {
      delivered.push(prompt);
    },
  });
}

function createFrame(overrides: Partial<SendPromptFrame> = {}): SendPromptFrame {
  return {
    type: "send_prompt",
    msgId: "msg-1",
    targetSessionId: "session-1",
    prompt: "hello",
    hops: 0,
    ...overrides,
  };
}
