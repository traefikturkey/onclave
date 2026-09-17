import { describe, expect, it, vi } from "vitest";
import { createChannelMessage, ulid, type ChannelMessage, type ChannelSatisfaction } from "@onclave/envelope";
import onclavePi, { consume, type Runtime, validateMessageParams } from "../src/onclave-pi";
import { CorrelationStore, INBOUND_CUSTOM_TYPE } from "../src/lib/correlation";
import { SeenIds } from "../src/lib/dedup";
import { buildMessageFraming } from "../src/lib/framing";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => ".test-profile" }));
vi.mock("../src/lib/audit", () => ({ appendAdapterAuditEvent: vi.fn(async () => undefined) }));

const audit = vi.fn(async () => undefined);
const agentA = { instance_id: "pi-a", name: "A", host: "host-a" };
const agentB = { instance_id: "pi-b", name: "B", host: "host-b" };
const channelId = ulid();

function request(to: string[] = [agentB.instance_id]): ChannelMessage {
  return createChannelMessage({
    channel_id: channelId,
    kind: "request",
    origin: agentA,
    participants: [agentA.instance_id, ...to],
    response_requested_from: to,
    body: "please check",
  });
}

function runtime() {
  const outbound = createChannelMessage({ channel_id: channelId, kind: "note", origin: agentB, participants: [agentA.instance_id, agentB.instance_id], body: "posted" });
  const client = {
    call: vi.fn(async (input: Record<string, unknown>) => input.op === "list_agents" ? { ok: true, agents: [
      { ...agentA, alive: true },
      { ...agentB, alive: true },
      { instance_id: "pi-c", agent_id: "pi-c", name: "C", host: "host-c", alive: true },
    ] } : { ok: true }),
    postChannelMessage: vi.fn(async (_draft: Record<string, unknown>) => ({ message: outbound, duplicate: false })),
    dispose: vi.fn(async () => undefined),
  };
  const rt = {
    lifetime: new AbortController(),
    card: { agent_id: agentB.instance_id, name: agentB.name, host: agentB.host, transport: "https" as const },
    client,
    link: { stop: vi.fn(async () => undefined) },
    state: "connected" as const,
    registered: true,
    correlation: new CorrelationStore(),
    seen: new SeenIds(),
    aliveInstances: 1,
    ui: { notify: vi.fn(), setStatus: vi.fn() },
    sendMessage: vi.fn(),
  };
  return { rt: rt as unknown as Runtime, client, send: rt.sendMessage, ui: rt.ui };
}

describe("asynchronous channel delivery", () => {
  it("triggers only named request responders and never creates a task", async () => {
    const { rt, send, client } = runtime();
    const item = request();
    await consume(rt, { deliveryId: "request", kind: "message", message: item }, { audit });
    await consume(rt, { deliveryId: "request", kind: "message", message: item }, { audit });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ customType: INBOUND_CUSTOM_TYPE }), { triggerTurn: true, deliverAs: "followUp" });
    expect(client.call).not.toHaveBeenCalledWith(expect.objectContaining({ op: "create_task" }));
    expect(client.dispose).toHaveBeenLastCalledWith("request", "ack");
  });

  it("delivers notifications as one-way turns without inbound correlation", async () => {
    const { rt, send, ui } = runtime();
    const notification = createChannelMessage({
      channel_id: channelId,
      kind: "notification",
      origin: agentA,
      participants: [agentA.instance_id, agentB.instance_id],
      body: "vault job completed",
    });
    await consume(rt, { deliveryId: "notification", kind: "message", message: notification }, { audit });
    await consume(rt, { deliveryId: "notification", kind: "message", message: notification }, { audit });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ customType: INBOUND_CUSTOM_TYPE, content: expect.stringContaining("do not call onclave_message") }), { triggerTurn: true, deliverAs: "followUp" });
    expect(rt.correlation.inFlightCount()).toBe(0);
    expect(ui.notify).toHaveBeenCalledWith("Onclave notification received", "info");
  });

  it("displays non-responders, notes, and responses without starting turns", async () => {
    const { rt, send } = runtime();
    const group = request(["pi-c"]);
    const note = createChannelMessage({ channel_id: channelId, kind: "note", origin: agentA, participants: group.participants, body: "deployment completed" });
    const direct = request();
    const response = createChannelMessage({ channel_id: channelId, kind: "response", origin: agentB, participants: direct.participants, in_reply_to: direct.message_id, body: "healthy" });
    await consume(rt, { deliveryId: "non-responder", kind: "message", message: group }, { audit });
    await consume(rt, { deliveryId: "note", kind: "message", message: note }, { audit });
    await consume(rt, { deliveryId: "response", kind: "message", message: response }, { audit });
    expect(send.mock.calls.every(([, options]) => options.triggerTurn === false)).toBe(true);
    expect(String(send.mock.calls[0]?.[0] && (send.mock.calls[0][0] as { content?: string }).content)).toContain("No response is expected from this instance");
  });

  it("retains a session-owned inbound request for the body-only response form", async () => {
    const { rt } = runtime();
    const inbound = request();
    await consume(rt, { deliveryId: "active", kind: "message", message: inbound }, { audit });
    expect(rt.correlation.activeInboundRequest()).toEqual(inbound);
    expect(buildMessageFraming(inbound)).toContain("use onclave_message with only a body");
    rt.correlation.completeInbound(inbound.message_id);
    expect(rt.correlation.activeInboundRequest()).toBeUndefined();
  });

  it("uses objective any/all framing without making a response a turn", () => {
    const satisfaction: ChannelSatisfaction = {
      channel_id: channelId,
      request_message_id: ulid(),
      response_requested_from: [agentB.instance_id, "pi-c"],
      response_policy: "all",
      responders_received: [agentB.instance_id],
      state: "open",
    };
    const response = createChannelMessage({ channel_id: channelId, kind: "response", origin: agentB, participants: [agentA.instance_id, agentB.instance_id], in_reply_to: satisfaction.request_message_id, body: "partial" });
    expect(buildMessageFraming(response)).toContain("No response is expected");
  });
});

describe("onclave_message tool boundary", () => {
  it("requires kind/to/body for new messages and supports only body for active responses", () => {
    expect(validateMessageParams({ kind: "request", to: ["pi-b"], body: "check" })).toBe("request");
    expect(validateMessageParams({ kind: "request", to: ["pi-b", "pi-c"], response_policy: "all", body: "report" })).toBe("request");
    expect(validateMessageParams({ kind: "note", to: ["pi-b"], body: "done" })).toBe("note");
    expect(validateMessageParams({ body: "answer" }, true)).toBe("response");
    expect(() => validateMessageParams({ body: "answer" })).toThrow("kind is required");
    expect(() => validateMessageParams({ kind: "request", body: "missing target" })).toThrow("requires to");
    expect(() => validateMessageParams({ kind: "note", to: ["pi-b"], response_policy: "all", body: "bad" })).toThrow("note");
    expect(() => validateMessageParams({ kind: "response", body: "bad" })).toThrow("outside an active request");
    expect(() => validateMessageParams({ type: "inform", body: "old" } as never)).toThrow("not supported");
  });

  it("has no agent-settled publication hook and posts a group request once", async () => {
    const { rt, client } = runtime();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const pi = {
      registerFlag() {},
      getFlag: vi.fn(),
      getSessionName: () => "B",
      getActiveTools: () => ["read"],
      setActiveTools() {},
      on: (name: string, handler: (...args: unknown[]) => unknown) => { hooks.set(name, handler); },
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.push(tool),
      registerCommand() {},
      sendMessage: vi.fn(),
    };
    onclavePi(pi as never, { startAdapter: async () => rt });
    expect(hooks.has("agent_settled")).toBe(false);
    hooks.get("session_start")?.({}, { ui: { notify: vi.fn() } });
    await vi.waitFor(() => expect(tools.some((tool) => tool.name === "onclave_message")).toBe(true));
    const tool = tools.find((candidate) => candidate.name === "onclave_message");
    await tool?.execute("call", { kind: "request", to: ["pi-c", "pi-a"], response_policy: "all", body: "report" }, new AbortController().signal);
    expect(client.postChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "request", to: ["pi-c", "pi-a"], response_policy: "all", body: "report" }), expect.anything());
    expect(client.postChannelMessage).toHaveBeenCalledOnce();
  });

  it("infers response correlation from the active request and clears it only after publication", async () => {
    const { rt, client } = runtime();
    const hooks = new Map<string, (...args: unknown[]) => unknown>();
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const pi = {
      registerFlag() {}, getFlag: vi.fn(), getSessionName: () => "B", getActiveTools: () => [], setActiveTools() {},
      on: (name: string, handler: (...args: unknown[]) => unknown) => { hooks.set(name, handler); },
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.push(tool), registerCommand() {}, sendMessage: vi.fn(),
    };
    onclavePi(pi as never, { startAdapter: async () => rt });
    hooks.get("session_start")?.({}, { ui: { notify: vi.fn() } });
    await vi.waitFor(() => expect(tools.some((tool) => tool.name === "onclave_message")).toBe(true));
    const inbound = request();
    await consume(rt, { deliveryId: "for-response", kind: "message", message: inbound }, { audit });
    const tool = tools.find((candidate) => candidate.name === "onclave_message");
    await tool?.execute("call", { body: "healthy" }, new AbortController().signal);
    expect(client.postChannelMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: "response", channel_id: inbound.channel_id, in_reply_to: inbound.message_id, body: "healthy" }), expect.anything());
    expect(rt.correlation.activeInboundRequest()).toBeUndefined();
  });
});
