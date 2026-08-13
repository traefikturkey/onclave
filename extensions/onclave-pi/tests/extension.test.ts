import { beforeEach, describe, expect, it, vi } from "vitest";

const httpClient = vi.hoisted(() => ({
  call: vi.fn<(request: object) => Promise<Record<string, unknown>>>(),
  publish: vi.fn<(envelope: object) => Promise<void>>(),
}));

vi.mock("../src/lib/audit", () => ({
  appendAdapterAuditEvent: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/connection", () => {
  class HttpLink {
    constructor(
      private readonly options: {
        onReady: (signal: AbortSignal) => Promise<void>;
        onStateChange?: (state: "connecting" | "connected" | "closed") => void;
      }
    ) {}

    start(): void {
      this.options.onStateChange?.("connecting");
      this.options.onStateChange?.("connected");
      void this.options.onReady(new AbortController().signal);
    }

    async stop(): Promise<void> {
      this.options.onStateChange?.("closed");
    }
  }

  return { HttpLink };
});

vi.mock("../src/lib/http-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/http-client")>();

  class OnclaveHttpClient {
    async call(request: object): Promise<Record<string, unknown>> {
      return httpClient.call(request);
    }

    async publish(envelope: object): Promise<void> {
      return httpClient.publish(envelope);
    }
  }

  return { ...actual, OnclaveHttpClient };
});

vi.mock("../src/lib/http-signer", () => ({
  loadDefaultRequestSigner: vi.fn(async () => ({
    keyId: "test",
    signRequest: () => ({}),
  })),
}));

import onclavePi, { resolveAdapterApiBase, refreshFooterStatus, resolveApiBase } from "../src/onclave-pi";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
type RegisteredTool = {
  name: string;
  parameters?: unknown;
  execute?: (callId: string, params: Record<string, unknown>) => Promise<ToolResult>;
};
type RegisteredCommand = { name: string };

describe("Onclave v2 adapter registration", () => {
  beforeEach(() => {
    httpClient.call.mockReset();
    httpClient.publish.mockReset();
  });

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
      "onclave_delegate",
      "onclave_get",
      "onclave_inform",
      "onclave_send",
    ]);
  });

  it("delegation tool exposes bounded non-destructive action classes", () => {
    const registered = createFakePi();
    onclavePi(registered.pi as never);
    const delegate = registered.tools.find((tool) => tool.name === "onclave_delegate");
    const serialized = JSON.stringify(delegate?.parameters);
    expect(serialized).toContain("infrastructure_apply");
    expect(serialized).toContain("data_migration");
    expect(serialized).not.toContain("delete");
    expect(serialized).not.toContain("destroy");
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

  it("inform tool makes its target optional for alive-peer broadcasts", () => {
    const registered = createFakePi();
    onclavePi(registered.pi as never);
    const inform = registered.tools.find((tool) => tool.name === "onclave_inform");
    const schema = inform?.parameters as { required?: readonly string[] } | undefined;
    expect(schema?.required).not.toContain("to");
  });

  it("uses stable session-specific default agent ids", async () => {
    httpClient.call.mockResolvedValue({ ok: true, agents: [] });
    const first = createFakePi({ "onclave-url": "https://api.example" }, "session-aaaaaaaa-bbbb");
    const second = createFakePi({ "onclave-url": "https://api.example" }, "session-cccccccc-dddd");
    onclavePi(first.pi as never);
    onclavePi(second.pi as never);

    await startSession(first);
    await startSession(second);
    const registrations = httpClient.call.mock.calls
      .filter(([request]) => hasOperation(request, "register"))
      .map(([request]) => (request as { card: { agent_id: string } }).card.agent_id);

    expect(registrations).toHaveLength(2);
    expect(registrations[0]).not.toBe(registrations[1]);
    expect(registrations[0]).toMatch(/-sessionaaaaa$/);
    expect(registrations[1]).toMatch(/-sessionccccc$/);

    await shutdownSession(first);
    await shutdownSession(second);
  });

  it("populates the footer peer count immediately and excludes self", async () => {
    httpClient.call.mockImplementation(async (request) => {
      if (hasOperation(request, "list_agents")) {
        const registration = httpClient.call.mock.calls.find(([candidate]) => hasOperation(candidate, "register"));
        const localAgentId = (registration?.[0] as { card: { agent_id: string } }).card.agent_id;
        return {
          ok: true,
          agents: [
            { agent_id: localAgentId, alive: true },
            { agent_id: "peer-a", alive: true },
            { agent_id: "sleeping-peer", alive: false },
          ],
        };
      }
      return { ok: true };
    });
    const registered = createFakePi({ "onclave-url": "https://api.example" });
    onclavePi(registered.pi as never);

    const { setStatus } = await startSession(registered);
    await vi.waitFor(() => {
      expect(setStatus).toHaveBeenCalledWith("onclave-v2", expect.stringContaining("Peers: 1"));
    });

    await shutdownSession(registered);
  });

  it("uses an explicit agent id without a session suffix", async () => {
    httpClient.call.mockResolvedValue({ ok: true, agents: [] });
    const registered = createFakePi({
      "onclave-url": "https://api.example",
      "onclave-id": "explicit-agent",
    });
    onclavePi(registered.pi as never);

    await startSession(registered);
    const registration = httpClient.call.mock.calls.find(([request]) => hasOperation(request, "register"));
    expect((registration?.[0] as { card: { agent_id: string } }).card.agent_id).toBe("explicit-agent");

    await shutdownSession(registered);
  });

  it("broadcasts inert informs directly to each alive peer", async () => {
    httpClient.call.mockResolvedValue({ ok: true });
    httpClient.publish.mockResolvedValue(undefined);
    const registered = createFakePi({ "onclave-url": "https://api.example" });
    onclavePi(registered.pi as never);

    await startSession(registered);
    const registerRequest = httpClient.call.mock.calls.find(([request]) => hasOperation(request, "register"));
    if (registerRequest === undefined) throw new Error("adapter did not register");
    const localAgentId = (registerRequest[0] as { card: { agent_id: string } }).card.agent_id;
    httpClient.call.mockImplementation(async (request) => {
      if (hasOperation(request, "list_agents")) {
        return {
          ok: true,
          agents: [
            { agent_id: localAgentId, alive: true },
            { agent_id: "peer-a", alive: true },
            { agent_id: "peer-b", alive: true },
            { agent_id: "sleeping-peer", alive: false },
            { agent_id: "*", alive: true },
          ],
        };
      }
      return { ok: true };
    });

    const inform = registered.tools.find((tool) => tool.name === "onclave_inform");
    if (inform?.execute === undefined) throw new Error("inform tool is not registered");
    const result = await inform.execute("call-1", { body: "maintenance notice" });

    expect(httpClient.call).toHaveBeenCalledWith({ op: "list_agents" });
    expect(httpClient.publish.mock.calls.map(([envelope]) => (envelope as { to: string }).to)).toEqual([
      "peer-a",
      "peer-b",
    ]);
    expect(httpClient.publish.mock.calls.map(([envelope]) => (envelope as { performative: string }).performative)).toEqual([
      "inform",
      "inform",
    ]);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "onclave_inform broadcast\nrecipients 2" }],
      details: { recipient_count: 2, recipients: ["peer-a", "peer-b"] },
    });

    await shutdownSession(registered);
  });

  it("keeps direct informs on the messages operation without listing agents", async () => {
    httpClient.call.mockResolvedValue({ ok: true });
    httpClient.publish.mockResolvedValue(undefined);
    const registered = createFakePi({ "onclave-url": "https://api.example" });
    onclavePi(registered.pi as never);

    await startSession(registered);
    const listCallsBeforeInform = httpClient.call.mock.calls.filter(
      ([request]) => hasOperation(request, "list_agents")
    ).length;
    const inform = registered.tools.find((tool) => tool.name === "onclave_inform");
    if (inform?.execute === undefined) throw new Error("inform tool is not registered");
    const result = await inform.execute("call-2", { body: "maintenance notice", to: "peer-a" });

    expect(httpClient.call.mock.calls.filter(([request]) => hasOperation(request, "list_agents"))).toHaveLength(
      listCallsBeforeInform
    );
    expect(httpClient.publish).toHaveBeenCalledTimes(1);
    expect(httpClient.publish.mock.calls[0]?.[0]).toMatchObject({
      performative: "inform",
      to: "peer-a",
    });
    expect(result.content[0]?.text).toBe("onclave_inform sent\nmsg_id " + result.details.msg_id);

    await shutdownSession(registered);
  });
});

describe("Onclave v2 API resolution", () => {
  it("canonicalizes an explicit HTTPS origin override", () => {
    expect(resolveApiBase("https://explicit.example", { ONCLAVE_API_BASE: "https://env.example" })).toBe(
      "https://explicit.example/api/v1/"
    );
  });

  it("uses the flag and environment before the BWS lookup", async () => {
    const loader = vi.fn(async () => "https://bws.example");

    await expect(
      resolveAdapterApiBase("https://flag.example", { ONCLAVE_API_BASE: "https://env.example" }, loader)
    ).resolves.toBe("https://flag.example/api/v1/");
    await expect(resolveAdapterApiBase(undefined, { ONCLAVE_API_BASE: "https://env.example" }, loader)).resolves.toBe(
      "https://env.example/api/v1/"
    );
    await expect(resolveAdapterApiBase(undefined, {}, loader)).resolves.toBe("https://bws.example/api/v1/");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("fails closed when neither an override nor BWS bootstrap is available", async () => {
    await expect(resolveAdapterApiBase(undefined, {}, async () => undefined)).rejects.toThrow(
      "Onclave BWS bootstrap is missing BITWARDEN_ACCESS_KEY"
    );
  });

  it("fails closed when the API base is unavailable", () => {
    expect(() => resolveApiBase(undefined, {})).toThrow("ONCLAVE_API_BASE is required");
  });
});

describe("Onclave v2 footer status", () => {
  it.each([
    ["connected", "\x1b[32m"],
    ["disconnected", "\x1b[31m"],
  ])("colors the client name for the %s state", (state, color) => {
    const setStatus = vi.fn();

    refreshFooterStatus({
      aliveAgents: 0,
      card: { agent_id: "dev-wks-mglenn-.dotfiles-main" },
      state,
      ui: { setStatus },
    } as never);

    expect(setStatus).toHaveBeenCalledWith(
      "onclave-v2",
      `Onclave: ${color}dev-wks-mglenn-.dotfiles-main\x1b[0m | Peers: 0`
    );
  });
});

function hasOperation(request: object, operation: string): boolean {
  return "op" in request && request.op === operation;
}

async function startSession(
  registered: ReturnType<typeof createFakePi>
): Promise<{ setStatus: ReturnType<typeof vi.fn> }> {
  const sessionStart = registered.hooks.find((hook) => hook.event === "session_start");
  if (sessionStart === undefined) throw new Error("session_start hook is not registered");
  const setStatus = vi.fn();
  await sessionStart.handler({}, {
    cwd: process.cwd(),
    sessionManager: registered.sessionManager,
    ui: { notify: vi.fn(), setStatus },
  });
  await vi.waitFor(() => {
    expect(httpClient.call.mock.calls.some(([request]) => hasOperation(request, "register"))).toBe(true);
  });
  return { setStatus };
}

async function shutdownSession(registered: ReturnType<typeof createFakePi>): Promise<void> {
  const sessionShutdown = registered.hooks.find((hook) => hook.event === "session_shutdown");
  if (sessionShutdown === undefined) throw new Error("session_shutdown hook is not registered");
  await sessionShutdown.handler();
}

function createFakePi(flagValues: Record<string, unknown> = {}, sessionId = "session-default-1234") {
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
    getFlag(name: string) {
      return flagValues[name];
    },
    sendMessage() {},
  };
  const sessionManager = { getSessionId: () => sessionId };
  return { pi, flags, hooks, commands, tools, sessionManager };
}
