import { afterEach, describe, expect, it, vi } from "vitest";
import { createMessage, ulid, type Message, type TaskStatusEvent } from "@onclave/envelope";
import onclavePi, { consume, submitRunReply, type Runtime } from "../src/onclave-pi";
import { CorrelationStore, INBOUND_CUSTOM_TYPE } from "../src/lib/correlation";
import { SeenIds } from "../src/lib/dedup";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => ".test-profile" }));
vi.mock("../src/lib/audit", () => ({ appendAdapterAuditEvent: vi.fn(async () => undefined) }));
afterEach(() => vi.useRealTimers());
const audit = vi.fn(async () => undefined);
function outgoing(type: "ask" | "request" = "ask", context_id = ulid(), task_id?: string): Message {
  const id = ulid();
  return createMessage({ messageId: id, trace_id: id, type, origin: { instance_id: "a", name: "A", host: "host-a" }, destination: "b", context_id, task_id, body: "question" });
}
function status(message: Message, state: TaskStatusEvent["state"], task_id = message.task_id ?? ulid()): TaskStatusEvent {
  return { protocol_version: 1, event_id: ulid(), context_id: message.context_id, task_id, origin_instance_id: "a", destination: "a", state, occurred_at: new Date().toISOString(), message_id: message.message_id, body: state };
}
function runtime() {
  const client = {
    call: vi.fn(async (request: Record<string, unknown>) => request.op === "create_task" ? { ok: true, task: { task_id: ulid(), state: "submitted" } } : { ok: true }),
    publish: vi.fn(async (_message: Message) => undefined),
    dispose: vi.fn(async () => undefined),
  };
  const rt = {
    lifetime: new AbortController(), card: { agent_id: "b", name: "B", host: "host-b", transport: "https" },
    client, link: { stop: vi.fn(async () => undefined) }, state: "connected", registered: true,
    correlation: new CorrelationStore(), seen: new SeenIds(), aliveInstances: 1,
    ui: { notify: vi.fn(), confirm: vi.fn(), setStatus: vi.fn() }, sendMessage: vi.fn(),
  };
  return { rt: rt as unknown as Runtime, client, send: rt.sendMessage, ui: rt.ui };
}
function marker(message: Message) { return { role: "custom", customType: INBOUND_CUSTOM_TYPE, details: { messageId: message.message_id } }; }
function assistant(text: string, stopReason = "stop") { return { role: "assistant", stopReason, content: [{ type: "text", text }], errorMessage: stopReason === "error" ? "provider failed" : undefined }; }

describe("running-session communication", () => {
  it("accepts cross-host work without confirmation, queues a follow-up, and deduplicates", async () => {
    const { rt, send, ui, client } = runtime(); const message = outgoing("request");
    const delivery = { deliveryId: "delivery", kind: "message" as const, message };
    await consume(rt, delivery, { audit }); await consume(rt, delivery, { audit });
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ customType: INBOUND_CUSTOM_TYPE }), { triggerTurn: true, deliverAs: "followUp" });
    expect(client.call.mock.calls.map(([request]) => request.op)).toEqual(["create_task", "update_task"]);
    expect(client.dispose).toHaveBeenLastCalledWith("delivery", "ack");
  });

  it("delivers informs and unmatched statuses without initiating work", async () => {
    const { rt, send, client } = runtime();
    const request = outgoing();
    const inform = createMessage({ ...request, type: "inform", body: "notice" });
    await consume(rt, { deliveryId: "inform", kind: "message", message: inform }, { audit });
    await consume(rt, { deliveryId: "status", kind: "task-status", status: status(request, "completed") }, { audit });
    expect(send.mock.calls.every(([, options]) => options.triggerTurn === false)).toBe(true);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("routes only correlated terminal outcomes as follow-up turns", async () => {
    const { rt, send } = runtime(); const request = outgoing("request"); rt.correlation.registerOutbound(request);
    await consume(rt, { deliveryId: "working", kind: "task-status", status: status(request, "working") }, { audit });
    await consume(rt, { deliveryId: "done", kind: "task-status", status: status(request, "completed") }, { audit });
    expect(send.mock.calls.map(([, options]) => options)).toEqual([
      { triggerTurn: false, deliverAs: "followUp" }, { triggerTurn: true, deliverAs: "followUp" },
    ]);
  });

  it.each([["stop", "completed"], ["error", "failed"], ["aborted", "canceled"]])("reports %s as %s and never replies to unrelated turns", async (reason, state) => {
    const { rt, client } = runtime(); const message = outgoing("request", ulid(), ulid()); rt.correlation.registerInbound(message);
    await submitRunReply(rt, [assistant("unrelated")], audit);
    expect(client.publish).not.toHaveBeenCalled();
    await submitRunReply(rt, [marker(message), assistant("answer", reason)], audit);
    expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ state, message_id: message.message_id }));
    expect(client.publish).toHaveBeenCalledWith(expect.objectContaining({ trace_id: message.trace_id, destination: "a" }));
    expect(rt.correlation.inFlightCount()).toBe(0);
  });

  it("keeps queued responses separate and uses the successful automatic retry outcome", async () => {
    const { rt, client } = runtime(); const first = outgoing(), second = outgoing();
    rt.correlation.registerInbound(first); rt.correlation.registerInbound(second);
    await submitRunReply(rt, [marker(first), assistant("", "error"), assistant("first answer"), marker(second), assistant("second answer")], audit);
    expect(client.publish.mock.calls.map(([message]) => [message.trace_id, message.body])).toEqual([[first.trace_id, "first answer"], [second.trace_id, "second answer"]]);
  });

  it("leaves a pre-effect failure leased and retries it without terminal rejection", async () => {
    const { rt, client, send } = runtime(); const message = outgoing("request"); let creates = 0;
    client.call.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.op === "create_task" && creates++ === 0) throw new Error("temporary task API failure");
      return request.op === "create_task" ? { ok: true, task: { task_id: ulid(), state: "submitted" } } : { ok: true };
    });
    const delivery = { deliveryId: "retry", kind: "message" as const, message };
    await expect(consume(rt, delivery, { audit })).rejects.toThrow("temporary task API failure");
    expect(client.dispose).not.toHaveBeenCalled();
    await consume(rt, delivery, { audit });
    expect(send).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenCalledWith("retry", "ack");
  });

  it("reuses prepared task identity after a later effect fails", async () => {
    const { rt, client, send } = runtime(); const message = outgoing("request"); let workingAttempts = 0;
    const taskId = ulid();
    client.call.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.op === "create_task") return { ok: true, task: { task_id: taskId, state: "submitted" } };
      if (request.op === "update_task" && workingAttempts++ === 0) throw new Error("temporary transition failure");
      return { ok: true };
    });
    const delivery = { deliveryId: "prepared", kind: "message" as const, message };
    await expect(consume(rt, delivery, { audit })).rejects.toThrow("temporary transition failure");
    await consume(rt, delivery, { audit });
    expect(client.call.mock.calls.filter(([request]) => request.op === "create_task")).toHaveLength(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ taskId }) }), expect.anything());
  });

  it("does not repeat correlation after Pi status delivery fails", async () => {
    const { rt, send, client } = runtime(); const request = outgoing("request"); rt.correlation.registerOutbound(request);
    const event = status(request, "completed"); const acceptStatus = vi.spyOn(rt.correlation, "acceptStatus");
    send.mockImplementationOnce(() => { throw new Error("Pi injection failed"); });
    const delivery = { deliveryId: "status-retry", kind: "task-status" as const, status: event };
    await expect(consume(rt, delivery, { audit })).rejects.toThrow("Pi injection failed");
    expect(client.dispose).not.toHaveBeenCalled();
    await consume(rt, delivery, { audit });
    expect(acceptStatus).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("acknowledges delivered state after audit failure without replay", async () => {
    const { rt, send, client } = runtime(); const message = outgoing("request");
    const failedAudit = vi.fn().mockRejectedValueOnce(new Error("audit unavailable"));
    const delivery = { deliveryId: "audit", kind: "message" as const, message };
    await consume(rt, delivery, { audit: failedAudit });
    await consume(rt, delivery, { audit: failedAudit });
    expect(send).toHaveBeenCalledOnce();
    expect(client.dispose).toHaveBeenNthCalledWith(1, "audit", "ack");
    expect(client.dispose).toHaveBeenNthCalledWith(2, "audit", "ack");
  });

  it("keeps a concurrent duplicate pending until the first lease can finish", async () => {
    const { rt, client } = runtime(); const message = outgoing("request"); let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    client.call.mockImplementation(async (request: Record<string, unknown>) => {
      if (request.op === "create_task") { await blocked; return { ok: true, task: { task_id: ulid(), state: "submitted" } }; }
      return { ok: true };
    });
    const delivery = { deliveryId: "concurrent", kind: "message" as const, message };
    const first = consume(rt, delivery, { audit });
    await vi.waitFor(() => expect(client.call).toHaveBeenCalledWith(expect.objectContaining({ op: "create_task" })));
    await expect(consume(rt, delivery, { audit })).rejects.toThrow("already processing");
    expect(client.dispose).not.toHaveBeenCalled();
    release();
    await first;
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("settles a tool wait and closes the runtime on session shutdown", async () => {
    const { rt, client } = runtime();
    const hooks = new Map<string, (...args: any[]) => any>(); const tools: any[] = [];
    const pi = { registerFlag() {}, getActiveTools: () => ["read"], setActiveTools() {}, on: (name: string, handler: any) => hooks.set(name, handler), registerTool: (tool: any) => tools.push(tool), registerCommand() {} };
    onclavePi(pi as never, { startAdapter: async () => rt });
    hooks.get("session_start")!({}, { ui: { notify: vi.fn() } });
    await vi.waitFor(() => expect(hooks.has("agent_settled")).toBe(true));
    await Promise.resolve();
    const result = tools.find((tool) => tool.name === "onclave_message").execute("call", { type: "ask", to: "a", body: "hello" });
    await vi.waitFor(() => expect(client.publish).toHaveBeenCalledOnce());
    const inbound = outgoing("request");
    await consume(rt, { deliveryId: "shutdown", kind: "message", message: inbound }, { audit });
    expect(rt.seen.has(inbound.message_id)).toBe(true);
    await hooks.get("session_shutdown")!();
    expect(rt.seen.has(inbound.message_id)).toBe(false);
    expect((await result).details.messages[0].result).toBe("session_closed");
    expect(rt.lifetime.signal.aborted).toBe(true);
    await expect(tools[0].execute()).rejects.toThrow("not connected");
  });
});

describe("exchange correlation", () => {
  it("waits through intermediate status, then resolves a terminal result", async () => {
    const store = new CorrelationStore(), message = outgoing(); store.registerOutbound(message);
    const resolved = vi.fn(); const wait = store.waitFor(message, 1000).then(resolved);
    expect(store.acceptStatus(status(message, "working"))).toBe(true); await Promise.resolve(); expect(resolved).not.toHaveBeenCalled();
    store.acceptStatus(status(message, "completed")); await wait; expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ state: "completed" }));
  });

  it("matches direct replies by peer and exchange trace within a shared context", async () => {
    const store = new CorrelationStore(), first = outgoing(), second = outgoing("ask", first.context_id);
    store.registerOutbound(first); store.registerOutbound(second);
    const reply = createMessage({ type: "inform", origin: { instance_id: "b", name: "B", host: "host-b" }, destination: "a", context_id: first.context_id, trace_id: second.trace_id, body: "second answer" });
    expect(store.acceptReply(reply)).toBe(true);
    expect(await store.waitFor(second, 100)).toEqual(reply); expect(store.getReply(first.message_id)).toBeUndefined();
    expect(store.acceptReply(reply)).toBe(false);
  });

  it("does not let an old task outcome complete its continuation", async () => {
    const store = new CorrelationStore(), task = ulid(), first = outgoing("ask", ulid(), task); store.registerOutbound(first);
    store.acceptStatus(status(first, "input-required"));
    const next = outgoing("ask", first.context_id, task); store.registerOutbound(next);
    expect(store.acceptStatus(status(first, "completed"))).toBe(false);
    store.acceptStatus(status(next, "completed")); expect(await store.waitFor(next, 100)).toMatchObject({ message_id: next.message_id });
  });

  it("bounds the wait without canceling remote work and settles waits on clear", async () => {
    vi.useFakeTimers(); const store = new CorrelationStore(), message = outgoing(); store.registerOutbound(message);
    const wait = store.waitFor(message, 20); await vi.advanceTimersByTimeAsync(20); expect(await wait).toBeUndefined();
    expect(store.acceptStatus(status(message, "completed"))).toBe(true);
    const second = outgoing(); store.registerOutbound(second); const pending = store.waitFor(second, 100); store.clear(); expect(await pending).toBeUndefined();
  });

  it("allows cancellation of a local ask wait", async () => {
    const store = new CorrelationStore(), message = outgoing(); store.registerOutbound(message); const controller = new AbortController();
    const wait = store.waitFor(message, 1000, controller.signal); const assertion = expect(wait).rejects.toThrow("cancel"); controller.abort(new Error("cancel")); await assertion;
    expect(store.acceptStatus(status(message, "completed"))).toBe(true);
  });
});
