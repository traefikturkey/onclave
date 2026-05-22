import { describe, expect, it } from "bun:test";
import comsLanExtension from "../../extensions/coms-lan";

type RegisteredTool = { name: string; parameters?: unknown; execute?: (...args: any[]) => unknown };
type RegisteredCommand = { name: string; handler?: (...args: any[]) => unknown };

describe("coms-lan extension registration", () => {
  it("registers lifecycle hooks, trust tools, static peer tools, and messaging tools", () => {
    const registered = createFakePi();

    comsLanExtension(registered.pi as never);

    expect(registered.flags.map((flag) => flag.name).sort()).toEqual(["color", "explicit", "name", "purpose"]);
    expect(registered.hooks.map((hook) => hook.event).sort()).toEqual(["agent_end", "session_shutdown", "session_start"]);
    expect(registered.commands.map((command) => command.name)).toContain("coms-lan-trust");
    expect(registered.tools.map((tool) => tool.name).sort()).toEqual([
      "coms_lan_agents",
      "coms_lan_await",
      "coms_lan_get",
      "coms_lan_peers",
      "coms_lan_remote_agents",
      "coms_lan_remote_get",
      "coms_lan_remote_send",
      "coms_lan_send",
      "coms_lan_static_peers",
      "coms_lan_status",
      "coms_lan_trust_add",
      "coms_lan_trust_info",
    ]);
  });

  it("remote tools accept static peer names as an alternative to explicit endpoint metadata", () => {
    const registered = createFakePi();
    comsLanExtension(registered.pi as never);

    const remoteAgents = registered.tools.find((tool) => tool.name === "coms_lan_remote_agents");
    const remoteSend = registered.tools.find((tool) => tool.name === "coms_lan_remote_send");
    const remoteGet = registered.tools.find((tool) => tool.name === "coms_lan_remote_get");

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
