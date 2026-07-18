import { describe, expect, it } from "vitest";
import onclaveExtension from "../src/onclave-comms";

type RegisteredTool = { name: string; parameters?: unknown; execute?: (...args: any[]) => unknown };
type RegisteredCommand = { name: string; handler?: (...args: any[]) => unknown };

describe("Onclave extension registration", () => {
  it("registers gateway lifecycle hooks and gateway messaging tools", () => {
    const registered = createFakePi();

    onclaveExtension(registered.pi as never);

    expect(registered.flags.map((flag) => flag.name).sort()).toEqual([]);
    expect(registered.hooks.map((hook) => hook.event).sort()).toEqual(["agent_end", "session_shutdown", "session_start"]);
    expect(registered.commands).toEqual([]);
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_await", "onclave_get", "onclave_send"]);
  });

});

function createFakePi() {
  const flags: Array<{ name: string; options: unknown }> = [];
  const hooks: Array<{ event: string; handler: (...args: any[]) => unknown }> = [];
  const commands: RegisteredCommand[] = [];
  const tools: RegisteredTool[] = [];
  const pi = {
    registerFlag(name: string, options: unknown) {
      flags.push({ name, options });
    },
    on(event: string, handler: (...args: any[]) => unknown) {
      hooks.push({ event, handler });
    },
    registerCommand(name: string, command: Omit<RegisteredCommand, "name">) {
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
