import { describe, expect, it } from "bun:test";
import onclaveExtension from "../src/onclave-comms";

type RegisteredTool = { name: string; parameters?: unknown; execute?: (...args: any[]) => unknown };
type RegisteredCommand = { name: string; handler?: (...args: any[]) => unknown };

describe("Onclave extension registration", () => {
  it("registers lifecycle hooks, trust tools, static peer tools, and messaging tools", () => {
    const registered = createFakePi();

    onclaveExtension(registered.pi as never);

    expect(registered.flags.map((flag) => flag.name).sort()).toEqual(["color", "explicit", "name", "purpose"]);
    expect(registered.hooks.map((hook) => hook.event).sort()).toEqual(["agent_end", "session_shutdown", "session_start"]);
    expect(registered.commands.map((command) => command.name)).toContain("onclave-trust");
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual([
      "onclave_agents",
      "onclave_await",
      "onclave_get",
      "onclave_peers",
      "onclave_remote_agents",
      "onclave_remote_get",
      "onclave_remote_send",
      "onclave_reply",
      "onclave_send",
      "onclave_static_peers",
      "onclave_status",
      "onclave_trust_add",
      "onclave_trust_info",
    ]);
  });

  it("remote tools accept static peer names as an alternative to explicit endpoint metadata", () => {
    const registered = createFakePi();
    onclaveExtension(registered.pi as never);

    const remoteAgents = registered.tools.find((tool) => tool.name === "onclave_remote_agents");
    const remoteSend = registered.tools.find((tool) => tool.name === "onclave_remote_send");
    const remoteGet = registered.tools.find((tool) => tool.name === "onclave_remote_get");

    expect(JSON.stringify(remoteAgents?.parameters)).toContain("peer_name");
    expect(JSON.stringify(remoteSend?.parameters)).toContain("peer_name");
    expect(JSON.stringify(remoteGet?.parameters)).toContain("peer_name");
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
