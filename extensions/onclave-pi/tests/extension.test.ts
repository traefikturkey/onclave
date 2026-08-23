import { beforeEach, describe, expect, it, vi } from "vitest";
import onclavePi, { setAdapterToolsActive, validateMessageParams } from "../src/onclave-pi";

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
    delete process.env.ONCLAVE_PI_SUBAGENT_INELIGIBLE;
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
