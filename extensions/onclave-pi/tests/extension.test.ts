import { spawnSync } from "node:child_process";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import onclavePi, { initializeRootCapability, ONCLAVE_ROOT_CAPABILITY_ENV, ONCLAVE_SUBAGENT_SENTINEL_ENV, setAdapterToolsActive, validateMessageParams } from "../src/onclave-pi";

type Tool = { name: string; parameters?: unknown };
function fakePi() {
  const tools: Tool[] = [];
  let activeTools = ["read", "onclave_instances", "onclave_message"];
  const pi = {
    registerFlag: vi.fn(), on: vi.fn(), registerCommand: vi.fn(), registerTool: (tool: Tool) => tools.push(tool), getFlag: vi.fn(), sendMessage: vi.fn(),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
  };
  return { pi, tools };
}

describe("Onclave Pi T2 adapter", () => {
  beforeEach(() => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_TREE_RUN_ID;
    delete process.env[ONCLAVE_SUBAGENT_SENTINEL_ENV];
    process.env[ONCLAVE_ROOT_CAPABILITY_ENV] = "root-capability";
  });

  afterEach(() => {
    delete process.env.PI_SUBAGENT_RUN_ID;
    delete process.env.PI_SUBAGENT_TREE_RUN_ID;
    delete process.env[ONCLAVE_SUBAGENT_SENTINEL_ENV];
    delete process.env[ONCLAVE_ROOT_CAPABILITY_ENV];
  });

  it("registers the adapter for an authorized root", () => {
    const registered = fakePi();
    onclavePi(registered.pi as never);
    expect(registered.pi.registerFlag).toHaveBeenCalled();
    expect(registered.pi.on).toHaveBeenCalledWith("session_start", expect.any(Function));
    expect(registered.pi.on).toHaveBeenCalledWith("session_shutdown", expect.any(Function));
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_instances", "onclave_message"]);
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
      card: { agent_id: "pi-test", name: "pi-test", host: "test", transport: "https" },
      link: { stop: vi.fn(async () => undefined) },
      client: {},
      state: "disconnected",
      correlation: { clear: vi.fn() },
      seen: {},
      ui: { setStatus: vi.fn() },
      sendMessage: vi.fn(),
      aliveInstances: 0,
      registered: false,
    };
    onclavePi(registered.pi as never, {
      registerSessionStart: (handler: typeof sessionStart) => { sessionStart = handler; },
      recordStartup,
      nowMs: () => now,
      startAdapter: () => new Promise((resolve) => { resolveStart = resolve; }),
    } as never);

    const returned = sessionStart?.({ reason: "reload" }, { ui: { notify: vi.fn() } } as never);
    expect(returned).toBeUndefined();
    expect(recordStartup).not.toHaveBeenCalled();

    now = 35;
    resolveStart?.(runtime);
    await vi.waitFor(() => expect(recordStartup).toHaveBeenCalledWith({ reason: "reload", durationMs: 25, status: "ok" }));

    const shutdown = registered.pi.on.mock.calls.find(([event]) => event === "session_shutdown")?.[1];
    await shutdown?.();
    expect(runtime.link.stop).toHaveBeenCalledOnce();
  });

  it("registers nothing and starts no session hooks without a provisioned capability", () => {
    delete process.env[ONCLAVE_ROOT_CAPABILITY_ENV];
    const heartbeat = vi.spyOn(globalThis, "setInterval");
    const registered = fakePi();
    onclavePi(registered.pi as never);
    expect(initializeRootCapability()).toBe(false);
    expect(registered.pi.registerFlag).not.toHaveBeenCalled();
    expect(registered.pi.on).not.toHaveBeenCalled();
    expect(registered.pi.registerCommand).not.toHaveBeenCalled();
    expect(registered.tools).toEqual([]);
    expect(heartbeat).not.toHaveBeenCalled();
    heartbeat.mockRestore();
  });

  it("denies a direct child even when it inherits the root capability", () => {
    expect(initializeRootCapability({ [ONCLAVE_ROOT_CAPABILITY_ENV]: "root-capability", PI_SUBAGENT_RUN_ID: "child-run" })).toBe(false);
  });

  it("denies a broker child even when it inherits the root capability", () => {
    expect(initializeRootCapability({ [ONCLAVE_ROOT_CAPABILITY_ENV]: "root-capability", [ONCLAVE_SUBAGENT_SENTINEL_ENV]: "broker-child" })).toBe(false);
  });

  it("denies a real subprocess with child markers removed and no capability", () => {
    const tsx = `${process.cwd()}/node_modules/tsx/dist/cli.mjs`;
    const result = spawnSync(process.execPath, [tsx, "-e", 'import { initializeRootCapability } from "./extensions/onclave-pi/src/lib/root-capability.ts"; delete process.env.ONCLAVE_PI_ROOT_CAPABILITY; delete process.env.PI_SUBAGENT_RUN_ID; delete process.env.PI_SUBAGENT_TREE_RUN_ID; delete process.env.ONCLAVE_PI_SUBAGENT_INELIGIBLE; console.log(initializeRootCapability())'], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, [ONCLAVE_ROOT_CAPABILITY_ENV]: "" },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("false");
  });

  it("registers only parameterless instance discovery and the unified message tool", () => {
    const registered = fakePi();
    onclavePi(registered.pi as never);
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_instances", "onclave_message"]);
    const instances = registered.tools.find((tool) => tool.name === "onclave_instances");
    expect(instances?.parameters).toMatchObject({ type: "object", properties: {} });
  });

  it("tracks adapter tool visibility without changing unrelated tools", () => {
    const registered = fakePi();
    setAdapterToolsActive(registered.pi as never, false);
    expect(registered.pi.setActiveTools).toHaveBeenLastCalledWith(["read"]);
    setAdapterToolsActive(registered.pi as never, true);
    expect(registered.pi.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "onclave_instances",
      "onclave_message",
    ]);
  });

  it("uses one flat provider-portable message schema", () => {
    const registered = fakePi();
    onclavePi(registered.pi as never);
    const message = registered.tools.find((tool) => tool.name === "onclave_message");
    const serialized = JSON.stringify(message?.parameters);
    expect(serialized).toContain("ask");
    expect(serialized).toContain("request");
    expect(serialized).toContain("inform");
    expect(serialized).not.toContain("oneOf");
    expect(serialized).not.toContain("delegat");
    expect(serialized).not.toContain("performative");
  });

  it.each([
    [{ type: "inform", body: "notice", timeout_ms: 10 }, "inform does not accept"],
    [{ type: "inform", body: "notice", task_id: "task" }, "inform does not accept"],
    [{ type: "ask", body: "question" }, "ask requires to"],
    [{ type: "request", body: "work" }, "request requires to"],
    [{ type: "request", to: "peer", body: "work", timeout_ms: 0 }, "timeout_ms"],
  ] as const)("rejects invalid conditional arguments before publication", (params, error) => {
    expect(() => validateMessageParams(params)).toThrow(error);
  });

  it("accepts direct and broadcast forms for all applicable fields", () => {
    expect(validateMessageParams({ type: "ask", to: "peer", body: "question", timeout_ms: 100 })).toBe("ask");
    expect(validateMessageParams({ type: "request", to: "peer", body: "work", context_id: "context", task_id: "task" })).toBe("request");
    expect(validateMessageParams({ type: "inform", to: "peer", body: "notice" })).toBe("inform");
    expect(validateMessageParams({ type: "inform", body: "notice" })).toBe("inform");
  });
});
