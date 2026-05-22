import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAuditEvent, type AuditEventName, type AuditMetadata } from "../src/coms-lan/audit";
import { bootstrapLocalHub, type BootstrapLocalHubResult } from "../src/coms-lan/bootstrap";
import { findStaticPeer, loadComsLanConfig } from "../src/coms-lan/config";
import { createLocalAgentRegistration } from "../src/coms-lan/extension-helpers";
import { loadIdentityPrivateKeyHex } from "../src/coms-lan/identity";
import { createRemoteHubClient, RemoteHubAuthError } from "../src/coms-lan/remote-client";
import type { DeliveredPrompt } from "../src/coms-lan/messages";
import type { LocalAgentRegistration } from "../src/coms-lan/local-registry";
import { getComsLanPaths } from "../src/coms-lan/state";
import { buildComsLanStatus } from "../src/coms-lan/status";
import { addAuthorizedKeyLine } from "../src/coms-lan/trust";
import { sendWssFrames } from "../src/coms-lan/wss-transport";

const DEFAULT_DISCOVERY_PORT = 48889;
const DEFAULT_BROADCAST_ADDRESS = "255.255.255.255";

export default function (pi: ExtensionAPI) {
  pi.registerFlag("name", {
    description: "Override Onclave local agent name",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("purpose", {
    description: "Describe this Onclave local agent purpose",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("color", {
    description: "Hex color #RRGGBB for this Onclave local agent",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("explicit", {
    description: "Hide this Onclave local agent from default listings",
    type: "boolean",
    default: false,
  });

  const paths = getComsLanPaths(`${homedir()}/.pi/coms-lan`);
  const audit = (event: AuditEventName, metadata: AuditMetadata) => appendAuditEvent(paths.auditLog, event, metadata);
  let bootstrap: BootstrapLocalHubResult | null = null;
  let localSessionId: string | null = null;
  let localRegistration: LocalAgentRegistration | null = null;
  const inboundPrompts = new Map<string, DeliveredPrompt>();

  pi.on("session_start", async (_event, ctx) => {
    bootstrap = await bootstrapLocalHub(paths, {
      host: "0.0.0.0",
      discoveryPort: DEFAULT_DISCOVERY_PORT,
      broadcastAddress: DEFAULT_BROADCAST_ADDRESS,
      now: () => new Date().toISOString(),
      healthCheck: checkHubHealth,
      deliverPrompt: async (prompt) => deliverInboundPrompt(pi, prompt, inboundPrompts),
      audit,
    });

    localSessionId = sessionIdFromContext(ctx);
    localRegistration = await createRegistrationForContext(pi, ctx, localSessionId);
    if (bootstrap.runtime?.registerLocalAgent) {
      bootstrap.runtime.registerLocalAgent(localRegistration);
    } else {
      await registerWithLocalHub(bootstrap.state.endpoint, localRegistration);
    }

    ctx.ui?.setStatus?.("onclave", bootstrap.started ? "onclave hub" : "onclave client");
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

  pi.registerCommand("onclave-trust", {
    description: "Show Onclave public key and authorized_keys trust setup paths",
    handler: async (_args, ctx) => {
      if (!bootstrap) {
        ctx.ui.notify("onclave is not initialized", "error");
        return;
      }
      ctx.ui.notify(
        `Add this line to a peer authorized_keys file:\n${bootstrap.publicAuthorizedKeyLine}\n\nLocal file: ${paths.authorizedKeys}`,
        "info"
      );
    },
  });

  pi.registerTool({
    name: "onclave_trust_info",
    label: "Onclave Trust Info",
    description: "Show the local public key line and authorized_keys path for trust setup.",
    parameters: Type.Object({}),
    async execute() {
      if (!bootstrap) throw new Error("onclave is not initialized");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `authorized_keys: ${paths.authorizedKeys}\n` +
              `public_key: ${bootstrap.publicAuthorizedKeyLine}`,
          },
        ],
        details: {
          authorizedKeysPath: paths.authorizedKeys,
          publicAuthorizedKeyLine: bootstrap.publicAuthorizedKeyLine,
        },
      };
    },
  });

  pi.registerTool({
    name: "onclave_trust_add",
    label: "Onclave Trust Add",
    description: "Validate and append a public ssh-ed25519 key line to the local Onclave authorized_keys file.",
    parameters: Type.Object({
      public_key_line: Type.String({ description: "Full ssh-ed25519 public key line from a peer onclave_trust_info output." }),
    }),
    async execute(_callId, params) {
      const result = await addAuthorizedKeyLine(paths, params.public_key_line);
      await audit("trust_changed", {
        action: "add",
        fingerprint: result.key.fingerprint,
        duplicate: !result.added,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: result.added
              ? "trusted key added; restart Onclave sessions to reload trust"
              : "trusted key already present; no change made",
          },
        ],
        details: {
          added: result.added,
          fingerprint: result.key.fingerprint,
          authorizedKeysPath: paths.authorizedKeys,
        },
      };
    },
  });

  pi.registerTool({
    name: "onclave_status",
    label: "Onclave Status",
    description: "Show local Onclave hub status and the public key line to add to trusted peers.",
    parameters: Type.Object({}),
    async execute() {
      if (!bootstrap) throw new Error("onclave is not initialized");
      const status = buildComsLanStatus({
        endpoint: bootstrap.state.endpoint,
        started: bootstrap.started,
        publicAuthorizedKeyLine: bootstrap.publicAuthorizedKeyLine,
        networkInterfaces: networkInterfaces(),
      });
      return {
        content: [
          {
            type: "text" as const,
            text: status.text,
          },
        ],
        details: {
          state: bootstrap.state,
          started: bootstrap.started,
          publicAuthorizedKeyLine: bootstrap.publicAuthorizedKeyLine,
          remoteEndpoints: status.details.remoteEndpoints,
        },
      };
    },
  });

  pi.registerTool({
    name: "onclave_peers",
    label: "Onclave Peers",
    description: "List discovered LAN hubs known to this Onclave runtime.",
    parameters: Type.Object({}),
    async execute() {
      const peers = bootstrap?.runtime?.discoveredPeers?.() ?? [];
      const config = await loadComsLanConfig(paths);
      return {
        content: [
          {
            type: "text" as const,
            text: `${peers.length} discovered peer(s), ${config.staticPeers.length} static peer(s)`,
          },
        ],
        details: { peers, staticPeers: config.staticPeers },
      };
    },
  });

  pi.registerTool({
    name: "onclave_static_peers",
    label: "Onclave Static Peers",
    description: "List persistent static peers configured in ~/.pi/coms-lan/config.json.",
    parameters: Type.Object({}),
    async execute() {
      const config = await loadComsLanConfig(paths);
      return {
        content: [{ type: "text" as const, text: `${config.staticPeers.length} static peer(s)` }],
        details: { staticPeers: config.staticPeers, configPath: paths.config },
      };
    },
  });

  pi.registerTool({
    name: "onclave_send",
    label: "Onclave Send",
    description: "Send a prompt to a local Onclave agent by session ID through the local hub.",
    parameters: Type.Object({
      target_session_id: Type.String({ description: "Target local agent session ID." }),
      prompt: Type.String({ description: "Prompt to deliver." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("onclave is not initialized");
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
        throw new Error(`onclave send failed: ${JSON.stringify(response ?? null)}`);
      }
      return {
        content: [{ type: "text" as const, text: `onclave_send → ${params.target_session_id}\nmsg_id ${msgId}` }],
        details: { msg_id: msgId, target_session_id: params.target_session_id, status: response.status },
      };
    },
  });

  pi.registerTool({
    name: "onclave_get",
    label: "Onclave Get",
    description: "Poll an Onclave message response by msg_id.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message ID returned by onclave_send." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("onclave is not initialized");
      const result = await getLocalResponse(bootstrap.state.endpoint, params.msg_id);
      return {
        content: [{ type: "text" as const, text: formatResponseResult(result) }],
        details: { msg_id: params.msg_id, result },
      };
    },
  });

  pi.registerTool({
    name: "onclave_await",
    label: "Onclave Await",
    description: "Wait for an Onclave message response by msg_id until timeout.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message ID returned by onclave_send." }),
      timeout_ms: Type.Optional(Type.Number({ description: "Maximum wait time in milliseconds. Default 30000." })),
    }),
    async execute(_callId, params) {
      const timeoutMs = typeof params.timeout_ms === "number" && params.timeout_ms > 0 ? params.timeout_ms : 30_000;
      const deadline = Date.now() + timeoutMs;
      if (!bootstrap) throw new Error("onclave is not initialized");
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
    name: "onclave_remote_agents",
    label: "Onclave Remote Agents",
    description: "List agents from a trusted remote Onclave hub using explicit metadata or a static peer name.",
    parameters: Type.Object({
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/coms-lan/config.json." })),
      endpoint: Type.Optional(Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." })),
      node_id: Type.Optional(Type.String({ description: "Remote persistent node ID." })),
      hub_instance_id: Type.Optional(Type.String({ description: "Remote runtime hub instance ID." })),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("onclave is not initialized");
      const remote = await resolveRemotePeer(paths, params);
      const client = await createRemoteClient(bootstrap, paths, remote.endpoint, remote.nodeId, remote.hubInstanceId);
      bootstrap.runtime?.markPeerAuthInProgress?.(remote.nodeId);
      try {
        const agents = await client.listAgents();
        bootstrap.runtime?.markPeerAuthenticated?.(remote.nodeId);
        return {
          content: [{ type: "text" as const, text: `${agents.length} remote agent(s)` }],
          details: { agents, endpoint: remote.endpoint, node_id: remote.nodeId },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_remote_send",
    label: "Onclave Remote Send",
    description: "Send a prompt to a trusted remote Onclave hub using explicit metadata or a static peer name.",
    parameters: Type.Object({
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/coms-lan/config.json." })),
      endpoint: Type.Optional(Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." })),
      node_id: Type.Optional(Type.String({ description: "Remote persistent node ID." })),
      hub_instance_id: Type.Optional(Type.String({ description: "Remote runtime hub instance ID." })),
      target_session_id: Type.String({ description: "Remote target agent session ID." }),
      prompt: Type.String({ description: "Prompt to deliver." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("onclave is not initialized");
      const msgId = `msg_${randomId()}`;
      const remote = await resolveRemotePeer(paths, params);
      const client = await createRemoteClient(bootstrap, paths, remote.endpoint, remote.nodeId, remote.hubInstanceId);
      bootstrap.runtime?.markPeerAuthInProgress?.(remote.nodeId);
      try {
        const response = await client.sendPrompt({
          msgId,
          targetSessionId: params.target_session_id,
          prompt: params.prompt,
          hops: 0,
        });
        bootstrap.runtime?.markPeerAuthenticated?.(remote.nodeId);
        if (response.type !== "send_accepted") {
          throw new Error(`remote send failed: ${JSON.stringify(response)}`);
        }
        return {
          content: [{ type: "text" as const, text: `onclave_remote_send → ${params.target_session_id}\nmsg_id ${msgId}` }],
          details: { msg_id: msgId, target_session_id: params.target_session_id, status: response.status, endpoint: remote.endpoint },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_remote_get",
    label: "Onclave Remote Get",
    description: "Poll a message response from a trusted remote Onclave hub.",
    parameters: Type.Object({
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/coms-lan/config.json." })),
      endpoint: Type.Optional(Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." })),
      node_id: Type.Optional(Type.String({ description: "Remote persistent node ID." })),
      hub_instance_id: Type.Optional(Type.String({ description: "Remote runtime hub instance ID." })),
      msg_id: Type.String({ description: "Message ID returned by onclave_remote_send." }),
    }),
    async execute(_callId, params) {
      if (!bootstrap) throw new Error("onclave is not initialized");
      const remote = await resolveRemotePeer(paths, params);
      const client = await createRemoteClient(bootstrap, paths, remote.endpoint, remote.nodeId, remote.hubInstanceId);
      bootstrap.runtime?.markPeerAuthInProgress?.(remote.nodeId);
      try {
        const result = await client.getResponse(params.msg_id);
        bootstrap.runtime?.markPeerAuthenticated?.(remote.nodeId);
        return {
          content: [{ type: "text" as const, text: formatResponseResult(result) }],
          details: { msg_id: params.msg_id, result, endpoint: remote.endpoint },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_agents",
    label: "Onclave Agents",
    description: "List local agents registered with this Onclave runtime.",
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
      customType: "onclave-inbound",
      content:
        `[inbound onclave message]\n` +
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

type RemotePeerParams = {
  peer_name?: string;
  endpoint?: string;
  node_id?: string;
  hub_instance_id?: string;
};

async function resolveRemotePeer(
  paths: ReturnType<typeof getComsLanPaths>,
  params: RemotePeerParams
): Promise<{ endpoint: string; nodeId: string; hubInstanceId: string }> {
  if (params.peer_name) {
    const peer = findStaticPeer(await loadComsLanConfig(paths), params.peer_name);
    if (!peer) throw new Error(`static peer not found: ${params.peer_name}`);
    return { endpoint: peer.endpoint, nodeId: peer.nodeId, hubInstanceId: peer.hubInstanceId };
  }
  if (!params.endpoint || !params.node_id || !params.hub_instance_id) {
    throw new Error("provide peer_name or endpoint, node_id, and hub_instance_id");
  }
  return { endpoint: params.endpoint, nodeId: params.node_id, hubInstanceId: params.hub_instance_id };
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
    authorizedKeys: bootstrap.authorizedKeys,
    remote: {
      nodeId,
      hubInstanceId,
      endpoint,
    },
    now: () => new Date().toISOString(),
    rejectUnauthorized: false,
    audit: (event, metadata) => appendAuditEvent(paths.auditLog, event, metadata),
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
    throw new Error(`onclave get failed: ${JSON.stringify(response ?? null)}`);
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
