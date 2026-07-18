import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import onclaveExtension from "../src/onclave-pi";

type RegisteredTool = { name: string; parameters?: unknown; execute?: (...args: any[]) => unknown };
type RegisteredCommand = { name: string; handler?: (...args: any[]) => unknown };

describe("Onclave extension registration", () => {
  it("validates the distributable manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../onclave.extension.json", import.meta.url), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "org.onclave.pi",
      name: "onclave-pi",
      runtime: "pi",
      entrypoint: "./src/onclave-pi.ts",
      protocolVersion: "v1",
    });
    expect((manifest.gateway as Record<string, unknown>).requiredCapabilities).toEqual(["message.send", "message.receive"]);
  });

  it("registers gateway lifecycle hooks and gateway messaging tools", () => {
    const registered = createFakePi();

    onclaveExtension(registered.pi as never);

    expect(registered.flags.map((flag) => flag.name).sort()).toEqual([]);
    expect(registered.hooks.map((hook) => hook.event).sort()).toEqual(["agent_end", "session_shutdown", "session_start"]);
    expect(registered.commands).toEqual([]);
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual(["onclave_await", "onclave_cancel", "onclave_send", "onclave_status", "onclave_task"]);
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
