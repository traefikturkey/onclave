import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import onclavePi, { buildAgentCard, isPiSubagent, refreshFooterStatus, resolveInstanceAlias, setAdapterToolsActive, shortInstanceId, validateMessageParams } from "../src/onclave-pi";

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: () => ".test-profile" }));
vi.mock("../src/lib/audit", () => ({ appendAdapterAuditEvent: vi.fn(async () => undefined) }));

type Tool = { name: string; parameters?: unknown; promptGuidelines?: string[] };
function fakePi() {
  const tools: Tool[] = [];
  let activeTools = ["read", "onclave_instances", "onclave_message", "onclave_vault_search", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs"];
  const pi = {
    registerFlag: vi.fn(), on: vi.fn(), registerCommand: vi.fn(), registerMessageRenderer: vi.fn(), registerTool: (tool: Tool) => tools.push(tool), getFlag: vi.fn(), sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
  };
  return { pi, tools };
}

describe("Onclave Pi T2 adapter", () => {
  beforeEach(() => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_TREE_RUN_ID;
  });

  afterEach(() => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_TREE_RUN_ID;
  });

  it("uses the complete Pi session id as the default instance id", async () => {
    const registered = fakePi();
    registered.pi.getFlag.mockReturnValue(undefined);
    const first = await buildAgentCard(registered.pi as never, {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "01a0a580-130b-7565-92e2-6d9fbd2747d2" },
    } as never);
    const second = await buildAgentCard(registered.pi as never, {
      cwd: process.cwd(),
      sessionManager: { getSessionId: () => "01a0a580-1ecd-701e-8b32-4e1409003ce5" },
    } as never);
    expect(first.agent_id).toBe("pi-01a0a580-130b-7565-92e2-6d9fbd2747d2");
    expect(second.agent_id).toBe("pi-01a0a580-1ecd-701e-8b32-4e1409003ce5");
    expect(second.agent_id).not.toBe(first.agent_id);
  });

  it("presents and resolves a short alias without shortening the routing identity", () => {
    const full = "pi-01a0a580-130b-7565-92e2-6d9fbd2747d2";
    expect(shortInstanceId(full)).toBe("pi-6d9fbd27");
    expect(resolveInstanceAlias("pi-6d9fbd27", [full])).toBe(full);
    expect(resolveInstanceAlias(full, [full])).toBe(full);

    const setStatus = vi.fn();
    refreshFooterStatus({ aliveInstances: 2, card: { agent_id: full }, state: "connected", ui: { setStatus } } as never);
    expect(setStatus).toHaveBeenCalledWith("onclave-v2", expect.stringContaining("pi-6d9fbd27"));
    expect(setStatus.mock.calls[0]?.[1]).not.toContain(full);
  });

  it("rejects an ambiguous short alias", () => {
    expect(() => resolveInstanceAlias("pi-6d9fbd27", [
      "pi-01a0a580-130b-7565-92e2-6d9fbd2747d2",
      "pi-01a0a581-2222-3333-4444-6d9fbd27aaaa",
    ])).toThrow("ambiguous");
  });

  it("registers the adapter without calling runtime actions during extension loading", () => {
    const registered = fakePi();
    registered.pi.getActiveTools.mockImplementation(() => { throw new Error("runtime action called during loading"); });
    registered.pi.setActiveTools.mockImplementation(() => { throw new Error("runtime action called during loading"); });
    expect(() => onclavePi(registered.pi as never)).not.toThrow();
    expect(registered.pi.registerFlag).toHaveBeenCalled();
    expect(registered.pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(registered.pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_instances", "onclave_message", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs", "onclave_vault_search"]);
    expect(registered.pi.getActiveTools).not.toHaveBeenCalled();
    expect(registered.pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("starts initialization after session_start returns and records its duration", async () => {
    const registered = fakePi();
    let sessionStart: ((event: { reason?: string }, ctx: never) => void) | undefined;
    let resolveStart: ((runtime: unknown) => void) | undefined;
    let now = 10;
    const recordStartup = vi.fn();
    const runtime = {
      lifetime: new AbortController(),
      card: { agent_id: "pi-test", name: "pi-test", host: "test", transport: "https" },
      link: { stop: vi.fn(async () => undefined) },
      client: { ingest: vi.fn(async () => ({ content_id: "content-1", job_id: "job-1" })) },
      state: "connected",
      apiBase: "https://onclave.test",
      correlation: { clear: vi.fn() },
      seen: {},
      ui: { setStatus: vi.fn() },
      sendMessage: vi.fn(),
      aliveInstances: 0,
      registered: true,
    };
    onclavePi(registered.pi as never, {
      registerSessionStart: (handler: typeof sessionStart) => { sessionStart = handler; },
      recordStartup,
      nowMs: () => now,
      startAdapter: () => new Promise((resolve) => { resolveStart = resolve; }),
      vaultClient: () => runtime.client,
    } as never);

    const returned = sessionStart?.({ reason: "reload" }, { ui: { notify: vi.fn() } } as never);
    expect(returned).toBeUndefined();
    expect(recordStartup).not.toHaveBeenCalled();

    now = 35;
    resolveStart?.(runtime);
    await vi.waitFor(() => expect(recordStartup).toHaveBeenCalledWith({ reason: "reload", durationMs: 25, status: "ok" }));

    const ingest = registered.tools.find((tool) => tool.name === "onclave_vault_ingest");
    await (ingest as unknown as { execute: Function }).execute("call", { url: "https://example.test/video" });
    expect(runtime.client.ingest).toHaveBeenCalledWith(
      expect.objectContaining({ notify_agent_id: "pi-test" }),
      expect.any(Object),
    );

    const shutdown = registered.pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    await shutdown?.();
    expect(runtime.link.stop).toHaveBeenCalledOnce();
  });

  it("cancels stale bootstrap generations on replacement and shutdown", async () => {
    const registered = fakePi();
    let sessionStart: ((event: { reason?: string }, ctx: never) => void) | undefined;
    const signals: AbortSignal[] = [];
    onclavePi(registered.pi as never, {
      registerSessionStart: (handler: typeof sessionStart) => { sessionStart = handler; },
      startAdapter: vi.fn((_pi: unknown, _ctx: unknown, options: { signal?: AbortSignal }) => {
        if (options.signal !== undefined) signals.push(options.signal);
        return new Promise(() => undefined);
      }),
    } as never);

    sessionStart?.({}, { ui: { notify: vi.fn() } } as never);
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    sessionStart?.({ reason: "reload" }, { ui: { notify: vi.fn() } } as never);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    const shutdown = registered.pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    await shutdown?.();
    expect(signals[1]?.aborted).toBe(true);
  });

  it("does not use the previous runtime identity while a replacement session starts", async () => {
    const registered = fakePi();
    const inherited = process.env.ONCLAVE_AGENT_ID;
    process.env.ONCLAVE_AGENT_ID = "inherited-agent";
    const runtime = (agentId: string) => ({
      lifetime: new AbortController(),
      card: { agent_id: agentId, name: agentId, host: "test", transport: "https" },
      link: { stop: vi.fn(async () => undefined) },
      client: { call: vi.fn(async () => ({ ok: true, agents: [] })) },
      state: "connected",
      apiBase: "https://onclave.test",
      correlation: { clear: vi.fn() },
      seen: { clear: vi.fn() },
      ui: { setStatus: vi.fn(), notify: vi.fn() },
      sendMessage: vi.fn(),
      aliveInstances: 0,
      registered: true,
    });
    const previous = runtime("old-agent");
    const replacement = runtime("new-agent");
    let sessionStart: ((event: { reason?: string }, ctx: never) => void) | undefined;
    let finishReplacement!: () => void;
    const startAdapter = vi.fn()
      .mockImplementationOnce(async (_pi: unknown, _ctx: unknown, startOptions: any) => {
        startOptions.onRegistered?.("old-agent");
        return previous;
      })
      .mockImplementationOnce((_pi: unknown, _ctx: unknown, startOptions: any) => new Promise((resolve) => {
        finishReplacement = () => {
          startOptions.onRegistered?.("new-agent");
          resolve(replacement);
        };
      }));
    try {
      onclavePi(registered.pi as never, {
        registerSessionStart: (handler: typeof sessionStart) => { sessionStart = handler; },
        startAdapter,
      } as never);
      sessionStart?.({}, { ui: { notify: vi.fn() } } as never);
      await vi.waitFor(() => expect(startAdapter).toHaveBeenCalledOnce());
      await vi.waitFor(() => expect(process.env.ONCLAVE_AGENT_ID).toBe("old-agent"));

      sessionStart?.({ reason: "replacement" }, { ui: { notify: vi.fn() } } as never);
      await vi.waitFor(() => expect(startAdapter).toHaveBeenCalledTimes(2));
      expect(process.env.ONCLAVE_AGENT_ID).toBe("inherited-agent");
      const ingest = registered.tools.find((tool) => tool.name === "onclave_vault_ingest");
      await expect((ingest as unknown as { execute: Function }).execute("call", { url: "https://example.test/video" })).rejects.toThrow("connected runtime agent");
      await vi.waitFor(() => expect(previous.link.stop).toHaveBeenCalledOnce());

      finishReplacement();
      await vi.waitFor(() => expect(process.env.ONCLAVE_AGENT_ID).toBe("new-agent"));
      const shutdown = registered.pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
      await shutdown?.();
      expect(process.env.ONCLAVE_AGENT_ID).toBe("inherited-agent");
    } finally {
      if (inherited === undefined) delete process.env.ONCLAVE_AGENT_ID;
      else process.env.ONCLAVE_AGENT_ID = inherited;
    }
  });

  it("registers nothing and starts no session hooks in a direct subagent", () => {
    process.env.PI_SUBAGENT_RUN_ID = "child-run";
    const heartbeat = vi.spyOn(globalThis, "setInterval");
    const registered = fakePi();
    onclavePi(registered.pi as never);
    expect(isPiSubagent()).toBe(true);
    expect(registered.pi.registerFlag).not.toHaveBeenCalled();
    expect(registered.pi.on).not.toHaveBeenCalled();
    expect(registered.pi.registerCommand).not.toHaveBeenCalled();
    expect(registered.tools).toEqual([]);
    expect(registered.pi.setActiveTools).not.toHaveBeenCalled();
    expect(heartbeat).not.toHaveBeenCalled();
    heartbeat.mockRestore();
  });

  it("identifies a tree subagent", () => {
    expect(isPiSubagent({ PI_SUBAGENT_TREE_RUN_ID: "tree-child-run" })).toBe(true);
  });

  it("does not identify an unmarked Pi process as a subagent", () => {
    expect(isPiSubagent({})).toBe(false);
  });

  it("registers only parameterless instance discovery and the unified message tool", () => {
    const registered = fakePi();
    onclavePi(registered.pi as never);
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_instances", "onclave_message", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs", "onclave_vault_search"]);
    const instances = registered.tools.find((tool) => tool.name === "onclave_instances");
    const message = registered.tools.find((tool) => tool.name === "onclave_message");
    expect(instances?.parameters).toMatchObject({ type: "object", properties: {} });
    expect(instances?.promptGuidelines).toEqual(expect.arrayContaining([expect.any(String)]));
    expect(message?.promptGuidelines).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("tracks adapter tool visibility without changing unrelated tools", () => {
    const registered = fakePi();
    setAdapterToolsActive(registered.pi as never, false);
    expect(registered.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "onclave_vault_search", "onclave_vault_content", "onclave_vault_ingest", "onclave_vault_jobs"]);
    setAdapterToolsActive(registered.pi as never, true);
    expect(registered.pi.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "onclave_vault_search",
      "onclave_vault_content",
      "onclave_vault_ingest",
      "onclave_vault_jobs",
      "onclave_instances",
      "onclave_message",
    ]);
  });

  it("uses one flat provider-portable message schema", () => {
    const registered = fakePi();
    onclavePi(registered.pi as never);
    const message = registered.tools.find((tool) => tool.name === "onclave_message");
    const serialized = JSON.stringify(message?.parameters);
    expect(serialized).toContain("request");
    expect(serialized).toContain("response");
    expect(serialized).toContain("note");
    expect(serialized).not.toContain("notification");
    expect(serialized).not.toContain("oneOf");
    expect(serialized).not.toContain("delegat");
    expect(serialized).not.toContain("performative");
  });

  it.each([
    [{ kind: "request", body: "work" }, "request requires to"],
    [{ kind: "notification", to: ["peer"], body: "callback" }, "must be request, response, or note"],
    [{ kind: "note", to: ["peer"], response_policy: "all", body: "notice" }, "note"],
    [{ kind: "response", body: "answer" }, "outside an active request"],
    [{ body: "answer" }, "kind is required"],
  ] as const)("rejects invalid channel arguments before publication", (params, error) => {
    expect(() => validateMessageParams(params)).toThrow(error);
  });

  it("accepts direct, group, note, and active response forms", () => {
    expect(validateMessageParams({ kind: "request", to: ["peer"], body: "question" })).toBe("request");
    expect(validateMessageParams({ kind: "request", to: ["peer", "other"], response_policy: "all", body: "work" })).toBe("request");
    expect(validateMessageParams({ kind: "note", to: ["peer"], body: "notice" })).toBe("note");
    expect(validateMessageParams({ body: "answer" }, true)).toBe("response");
  });
});
