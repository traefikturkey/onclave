import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { bootstrapLocalHub, type BootstrapLocalHubResult } from "../src/coms-lan/bootstrap";
import { createLocalAgentRegistration } from "../src/coms-lan/extension-helpers";
import { loadIdentityPrivateKeyHex } from "../src/coms-lan/identity";
import { createRemoteHubClient } from "../src/coms-lan/remote-client";
import type { DeliveredPrompt } from "../src/coms-lan/messages";
import type { LocalAgentRegistration } from "../src/coms-lan/local-registry";
import { getComsLanPaths } from "../src/coms-lan/state";
import { sendWssFrames } from "../src/coms-lan/wss-transport";

const DEFAULT_DISCOVERY_PORT = 48889;
const DEFAULT_BROADCAST_ADDRESS = "255.255.255.255";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("name", {
    description: "Override coms-lan local agent name",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("purpose", {
    description: "Describe this coms-lan local agent purpose",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("color", {
    description: "Hex color #RRGGBB for this coms-lan local agent",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("explicit", {
    description: "Hide this coms-lan local agent from default listings",
    type: "boolean",
    default: false,
  });

  const paths = getComsLanPaths(`${homedir()}/.pi/coms-lan`);
  let bootstrap: BootstrapLocalHubResult | null = null;
  let localSessionId: string | null = null;
  let localRegistration: LocalAgentRegistration | null = null;
  const inboundPrompts = new Map<string, DeliveredPrompt>();

  pi.on("session_start", async (_event, ctx) => {
    bootstrap = await bootstrapLocalHub(paths, {
      host: "127.0.0.1",
      discoveryPort: DEFAULT_DISCOVERY_PORT,
      broadcastAddress: DEFAULT_BROADCAST_ADDRESS,
      now: () => new Date().toISOString(),
      healthCheck: checkHubHealth,
      deliverPrompt: async (prompt) => deliverInboundPrompt(pi, prompt, inboundPrompts),
    });

    localSessionId = sessionIdFromContext(ctx);
    localRegistration = await createRegistrationForContext(pi, ctx, localSessionId);
    if (bootstrap.runtime?.registerLocalAgent) {
      bootstrap.runtime.registerLocalAgent(localRegistration);
    } else {
      await registerWithLocalHub(bootstrap.state.endpoint, localRegistration);
    }

    ctx.ui?.setStatus?.("coms-lan", bootstrap.started ? "coms-lan hub" : "coms-lan client");
  });

  pi.on("session_shutdown", async () => {
    if (bootstrap && localSessionId) {
      if (bootstrap.runtime?.unregisterLocalAgent) {
        bootstrap.runtime.unregisterLocalAgent(localSessionId);
      } else {
        await unregisterWithLocalHub(bootstrap.state.endpoint, localSessionId);
      }
    }
    if (bootstrap?.runtime && bootstrap.started) {
      await bootstrap.runtime.stop();
    }
    bootstrap = null;
    localSessionId = null;
    localRegistration = null;
    inboundPrompts.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!bootstrap || !localSessionId) return;
    const inbound = [...inboundPrompts.values()].at(-1);
    if (!inbound) return;
    const response = extractLastAssistantText(ctx);
    const responses = await sendWssFrames(
      localHubWssUrl(bootstrap.state.endpoint),
      [
        {
          type: "local_submit_response",
          msgId: inbound.msgId,
          responderSessionId: localSessionId,
          response,
          error: null,
          completedAt: new Date().toISOString(),
        },
      ],
      { rejectUnauthorized: false, timeoutMs: 5_000 }
    );
    const submit = responses[0];
    if (submit?.type === "response_submitted") {
      inboundPrompts.delete(inbound.msgId);
    }
  });

  pi.registerTool({
    name: "coms_lan_status",
    label: "Coms LAN Status",
    description: "Show local coms-lan hub status and the public key line to add to trusted peers.",
    parameters: Type.Object({}),
    async execute() {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `hub: ${bootstrap.state.endpoint}\n` +
              `started_here: ${bootstrap.started}\n` +
              `public_key: ${bootstrap.publicAuthorizedKeyLine}`,
          },
        ],
        details: {
          state: bootstrap.state,
          started: bootstrap.started,
          publicAuthorizedKeyLine: bootstrap.publicAuthorizedKeyLine,
        },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_peers",
    label: "Coms LAN Peers",
    description: "List discovered LAN hubs known to this coms-lan runtime.",
    parameters: Type.Object({}),
    async execute() {
      const peers = bootstrap?.runtime?.discoveredPeers?.() ?? [];
      return {
        content: [{ type: "text" as const, text: `${peers.length} discovered peer(s)` }],
        details: { peers },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_send",
    label: "Coms LAN Send",
    description: "Send a prompt to a local coms-lan agent by session ID through the local hub.",
    parameters: Type.Object({
      target_session_id: Type.String({ description: "Target local agent session ID." }),
      prompt: Type.String({ description: "Prompt to deliver." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      const msgId = `msg_${randomId()}`;
      const responses = await sendWssFrames(
        localHubWssUrl(bootstrap.state.endpoint),
        [
          {
            type: "local_send_prompt",
            msgId,
            targetSessionId: params.target_session_id,
            prompt: params.prompt,
            hops: 0,
          },
        ],
        { rejectUnauthorized: false, timeoutMs: 5_000 }
      );
      const response = responses[0];
      if (!response || response.type !== "send_accepted") {
        throw new Error(`coms-lan send failed: ${JSON.stringify(response ?? null)}`);
      }
      return {
        content: [{ type: "text" as const, text: `coms_lan_send → ${params.target_session_id}\nmsg_id ${msgId}` }],
        details: { msg_id: msgId, target_session_id: params.target_session_id, status: response.status },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_get",
    label: "Coms LAN Get",
    description: "Poll a coms-lan message response by msg_id.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message ID returned by coms_lan_send." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      const result = await getLocalResponse(bootstrap.state.endpoint, params.msg_id);
      return {
        content: [{ type: "text" as const, text: formatResponseResult(result) }],
        details: { msg_id: params.msg_id, result },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_await",
    label: "Coms LAN Await",
    description: "Wait for a coms-lan message response by msg_id until timeout.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message ID returned by coms_lan_send." }),
      timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds. Default 30000." })),
    }),
    async execute(_callId, params) {
      const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : 30_000;
      const deadline = Date.now() + timeoutMs;
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      let result = await getLocalResponse(bootstrap.state.endpoint, params.msg_id);
      while (result.status === "pending" && Date.now() < deadline) {
        await sleep(250);
        result = await getLocalResponse(bootstrap.state.endpoint, params.msg_id);
      }
      return {
        content: [{ type: "text" as const, text: formatResponseResult(result) }],
        details: { msg_id: params.msg_id, result },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_remote_agents",
    label: "Coms LAN Remote Agents",
    description: "List agents from a trusted remote coms-lan hub using explicit peer endpoint metadata.",
    parameters: Type.Object({
      endpoint: Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." }),
      node_id: Type.String({ description: "Remote persistent node ID." }),
      hub_instance_id: Type.String({ description: "Remote runtime hub instance ID." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      const client = await createRemoteClient(bootstrap, paths, params.endpoint, params.node_id, params.hub_instance_id);
      const agents = await client.listAgents();
      return {
        content: [{ type: "text" as const, text: `${agents.length} remote agent(s)` }],
        details: { agents, endpoint: params.endpoint, node_id: params.node_id },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_remote_send",
    label: "Coms LAN Remote Send",
    description: "Send a prompt to a trusted remote coms-lan hub using explicit peer endpoint metadata.",
    parameters: Type.Object({
      endpoint: Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." }),
      node_id: Type.String({ description: "Remote persistent node ID." }),
      hub_instance_id: Type.String({ description: "Remote runtime hub instance ID." }),
      target_session_id: Type.String({ description: "Remote target agent session ID." }),
      prompt: Type.String({ description: "Prompt to deliver." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      const msgId = `msg_${randomId()}`;
      const client = await createRemoteClient(bootstrap, paths, params.endpoint, params.node_id, params.hub_instance_id);
      const response = await client.sendPrompt({
        msgId,
        targetSessionId: params.target_session_id,
        prompt: params.prompt,
        hops: 0,
      });
      if (response.type !== "send_accepted") {
        throw new Error(`remote send failed: ${JSON.stringify(response)}`);
      }
      return {
        content: [{ type: "text" as const, text: `coms_lan_remote_send → ${params.target_session_id}\nmsg_id ${msgId}` }],
        details: { msg_id: msgId, target_session_id: params.target_session_id, status: response.status },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_remote_get",
    label: "Coms LAN Remote Get",
    description: "Poll a message response from a trusted remote coms-lan hub.",
    parameters: Type.Object({
      endpoint: Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." }),
      node_id: Type.String({ description: "Remote persistent node ID." }),
      hub_instance_id: Type.String({ description: "Remote runtime hub instance ID." }),
      msg_id: Type.String({ description: "Message ID returned by coms_lan_remote_send." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("coms-lan is not initialized");
      const client = await createRemoteClient(bootstrap, paths, params.endpoint, params.node_id, params.hub_instance_id);
      const result = await client.getResponse(params.msg_id);
      return {
        content: [{ type: "text" as const, text: formatResponseResult(result) }],
        details: { msg_id: params.msg_id, result },
      };
    },
  });

  pi.registerTool({
    name: "coms_lan_agents",
    label: "Coms LAN Agents",
    description: "List local agents registered with this coms-lan runtime.",
    parameters: Type.Object({}),
    async execute() {
      const agents = bootstrap?.runtime?.localAgents?.() ?? [];
      return {
        content: [{ type: "text" as const, text: `${agents.length} local agent(s)` }],
        details: { agents },
      };
    },
  });
}

async function deliverInboundPrompt(
  pi: ExtensionAPI,
  prompt: DeliveredPrompt,
  inboundPrompts: Map<string, DeliveredPrompt>
): Promise<void> {
  inboundPrompts.set(prompt.msgId, prompt);
  pi.sendMessage(
    {
      customType: "coms-lan-inbound",
      content:
        `[inbound coms-lan message]\n` +
        `[msg_id ${prompt.msgId}; reply with a normal assistant response.]\n\n` +
        prompt.prompt,
      display: true,
      details: { msgId: prompt.msgId, targetSessionId: prompt.targetSessionId, hops: prompt.hops },
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );
}

function extractLastAssistantText(ctx: ExtensionContext): string {
  let lastAssistantText = "";
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    if (typeof content === "string") {
      lastAssistantText = content;
    } else if (Array.isArray(content)) {
      lastAssistantText = content
        .filter((block): block is { type: "text"; text: string } => {
          return Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text";
        })
        .map((block) => block.text)
        .join("\n");
    }
  }
  return lastAssistantText;
}

async function createRemoteClient(
  bootstrap: BootstrapLocalHubResult,
  paths: ReturnType<typeof getComsLanPaths>,
  endpoint: string,
  nodeId: string,
  hubInstanceId: string
) {
  return createRemoteHubClient({
    identity: {
      nodeId: bootstrap.identity.nodeId,
      hubInstanceId: bootstrap.state.hubInstanceId,
      endpoint: localHubWssUrl(bootstrap.state.endpoint),
      publicKeyHex: bootstrap.identity.publicKey,
      privateKeyHex: await loadIdentityPrivateKeyHex(paths),
    },
    remote: {
      nodeId,
      hubInstanceId,
      endpoint,
    },
    now: () => new Date().toISOString(),
    rejectUnauthorized: false,
  });
}

async function createRegistrationForContext(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  sessionId: string
): Promise<LocalAgentRegistration> {
  return createLocalAgentRegistration({
    sessionId,
    instanceId: `pi_${randomId()}`,
    cwd: ctx.cwd || process.cwd(),
    model: ctx.model?.id ?? "unknown",
    name: readStringFlag(pi, "name"),
    purpose: readStringFlag(pi, "purpose"),
    color: readStringFlag(pi, "color"),
    explicit: pi.getFlag("explicit") === true,
    deliveryEndpoint: `local://${sessionId}`,
  });
}

async function registerWithLocalHub(endpoint: string, registration: LocalAgentRegistration): Promise<void> {
  await sendWssFrames(localHubWssUrl(endpoint), [{ type: "local_register", registration }], {
    rejectUnauthorized: false,
    timeoutMs: 2_000,
  });
}

async function unregisterWithLocalHub(endpoint: string, sessionId: string): Promise<void> {
  await sendWssFrames(localHubWssUrl(endpoint), [{ type: "local_unregister", sessionId }], {
    rejectUnauthorized: false,
    timeoutMs: 2_000,
  });
}

async function checkHubHealth(endpoint: string): Promise<boolean> {
  const url = localHubWssUrl(endpoint);
  try {
    const responses = await sendWssFrames(url, [{ type: "list_agents" }], {
      rejectUnauthorized: false,
      timeoutMs: 2_000,
    });
    return responses.some((response) => response.type === "error" && response.code === "auth_required") || responses.length > 0;
  } catch {
    return false;
  }
}

function localHubWssUrl(endpoint: string): string {
  return endpoint.replace(/^https:/, "wss:").replace(/\/$/, "") + "/v1/hub";
}

async function getLocalResponse(endpoint: string, msgId: string) {
  const responses = await sendWssFrames(
    localHubWssUrl(endpoint),
    [{ type: "local_get_response", msgId }],
    { rejectUnauthorized: false, timeoutMs: 5_000 }
  );
  const response = responses[0];
  if (!response || response.type !== "response") {
    throw new Error(`coms-lan get failed: ${JSON.stringify(response ?? null)}`);
  }
  return response.result;
}

function formatResponseResult(result: { status: string; response?: unknown; error?: string | null }): string {
  if (result.status === "complete") {
    return typeof result.response === "string" ? result.response : JSON.stringify(result.response, null, 2);
  }
  if (result.error) return `${result.status}: ${result.error}`;
  return result.status;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sessionIdFromContext(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) return basename(sessionFile).replace(/\W+/g, "_");
  return `session_${randomId()}`;
}

function readStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function randomId(): string {
  return randomBytes(10).toString("hex");
}
