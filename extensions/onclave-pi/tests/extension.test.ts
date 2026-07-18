import { describe, expect, it } from "vitest";
import onclavePi from "../src/onclave-pi";

type RegisteredTool = { name: string; parameters?: unknown };
type RegisteredCommand = { name: string };

describe("Onclave v2 adapter registration", () => {
  it("registers lifecycle hooks, flags, tools, and the status command", () => {
    const registered = createFakePi();

    onclavePi(registered.pi as never);

    expect(registered.flags.map((flag) => flag.name).sort()).toEqual(["onclave-id", "onclave-url"]);
    expect(registered.hooks.map((hook) => hook.event).sort()).toEqual([
      "agent_end",
      "session_shutdown",
      "session_start",
    ]);
    expect(registered.commands.map((command) => command.name)).toContain("onclave");
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual([
      "onclave_agents",
      "onclave_await",
      "onclave_get",
      "onclave_inform",
      "onclave_send",
    ]);
  });

  it("send tool restricts performatives to request and query", () => {
    const registered = createFakePi();
    onclavePi(registered.pi as never);
    const send = registered.tools.find((tool) => tool.name === "onclave_send");
    const serialized = JSON.stringify(send?.parameters);
    expect(serialized).toContain("request");
    expect(serialized).toContain("query");
    expect(serialized).not.toContain("inform");
  });
});

function createFakePi() {
  const flags: Array<{ name: string; options: unknown }> = [];
  const hooks: Array<{ event: string; handler: (...args: unknown[]) => unknown }> = [];
  const commands: RegisteredCommand[] = [];
  const tools: RegisteredTool[] = [];
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.push({ name, options });
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      hooks.push({ event, handler });
    },
    registerCommand(name: string, command: object) {
      commands.push({ name, ...command });
    },
    registerTool(tool: RegisteredTool) {
      tools.push(tool);
    },
    getFlag() {
      return undefined;
    },
    sendMessage() {},
  };
  return { pi, flags, hooks, commands, tools };
}
