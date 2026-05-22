import { randomBytes } from "node:crypto";
import { homedir, networkInterfaces } from "node:os";
import { basename } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendAuditEvent, type AuditEventName, type AuditMetadata } from "../src/onclave/audit";
import { bootstrapLocalHub, type BootstrapLocalHubResult } from "../src/onclave/bootstrap";
import { findStaticPeer, loadOnclaveConfig } from "../src/onclave/config";
import { createLocalAgentRegistration } from "../src/onclave/extension-helpers";
import { loadIdentityPrivateKeyHex } from "../src/onclave/identity";
import { createRemoteHubClient, RemoteHubAuthError } from "../src/onclave/remote-client";
import type { DeliveredPrompt } from "../src/onclave/messages";
import { renderOnclavePeerWidget } from "../src/onclave/peer-widget";
import type { LocalAgentRegistration } from "../src/onclave/local-registry";
import {
  assertAsyncReplyablePrompt,
  type PromptOriginMetadata,
} from "../src/onclave/prompt-metadata";
import { getOnclavePaths } from "../src/onclave/state";
import {
  buildOnclaveAgentList,
  buildOnclavePeers,
  buildOnclaveStatus,
  choosePreferredRemoteEndpoint,
} from "../src/onclave/status";
import { addAuthorizedKeyLine } from "../src/onclave/trust";
import { sendWssFrames } from "../src/onclave/wss-transport";

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

  const paths = getOnclavePaths(`${homedir()}/.pi/onclave`);
  const audit = (event: AuditEventName, metadata: AuditMetadata) => appendAuditEvent(paths.auditLog, event, metadata);
  let bootstrap: BootstrapLocalHubResult | null = null;
  let localSessionId: string | null = null;
  let localRegistration: LocalAgentRegistration | null = null;
  let sessionUi: ExtensionContext["ui"] | null = null;
  let peerWidgetTimer: ReturnType<typeof setInterval> | null = null;
  const peerDisplayCache = new Map<string, { model?: string }>();
  const inboundPrompts = new Map<string, DeliveredPrompt>();

  pi.on("session_start", async (_event, ctx) => {
    sessionUi = ctx.ui;
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

    await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
    peerWidgetTimer = setInterval(() => {
      void refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
    }, 5_000);
    peerWidgetTimer.unref?.();
  });

  pi.on("session_shutdown", async () => {
    if (peerWidgetTimer) {
      clearInterval(peerWidgetTimer);
      peerWidgetTimer = null;
    }
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
    sessionUi?.setWidget?.("onclave-peers", undefined);
    sessionUi?.setStatus?.("onclave", undefined);
    bootstrap = null;
    localSessionId = null;
    localRegistration = null;
    sessionUi = null;
    peerDisplayCache.clear();
    inboundPrompts.clear();
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!bootstrap || !localSessionId) return;
    const inbound = latestInboundPrompt(inboundPrompts);
    if (!inbound || inbound.replyMode === "async_message") return;
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
      const status = buildOnclaveStatus({
        endpoint: bootstrap.state.endpoint,
        started: bootstrap.started,
        nodeId: bootstrap.state.nodeId,
        hubInstanceId: bootstrap.state.hubInstanceId,
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
          nodeId: status.details.nodeId,
          hubInstanceId: status.details.hubInstanceId,
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
      const config = await loadOnclaveConfig(paths);
      const peerList = buildOnclavePeers({ discoveredPeers: peers, staticPeers: config.staticPeers });
      return {
        content: [
          {
            type: "text" as const,
            text: peerList.text,
          },
        ],
        details: { peers, staticPeers: config.staticPeers },
      };
    },
  });

  pi.registerTool({
    name: "onclave_static_peers",
    label: "Onclave Static Peers",
    description: "List persistent static peers configured in ~/.pi/onclave/config.json.",
    parameters: Type.Object({}),
    async execute() {
      const config = await loadOnclaveConfig(paths);
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
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/onclave/config.json." })),
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
        cachePeerDisplay(peerDisplayCache, remote.nodeId, agents);
        await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        const agentList = buildOnclaveAgentList({ heading: "remote_agents", agents });
        return {
          content: [{ type: "text" as const, text: agentList.text }],
          details: { agents, endpoint: remote.endpoint, node_id: remote.nodeId },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
          await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_remote_send",
    label: "Onclave Remote Send",
    description: "Send a prompt to a trusted remote Onclave hub using explicit metadata or a static peer name. Defaults to async replies via onclave_reply.",
    parameters: Type.Object({
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/onclave/config.json." })),
      endpoint: Type.Optional(Type.String({ description: "Remote WSS endpoint, for example wss://host:1234/v1/hub." })),
      node_id: Type.Optional(Type.String({ description: "Remote persistent node ID." })),
      hub_instance_id: Type.Optional(Type.String({ description: "Remote runtime hub instance ID." })),
      target_session_id: Type.String({ description: "Remote target agent session ID." }),
      prompt: Type.String({ description: "Prompt to deliver." }),
      reply_mode: Type.Optional(
        Type.Union([
          Type.Literal("async_message", { description: "Remote host replies later via onclave_reply. Default." }),
          Type.Literal("pollable", { description: "Remote host completes through onclave_remote_get polling." }),
        ])
      ),
    }),
    async execute(_callId, params) {
      if (!bootstrap || !localSessionId || !localRegistration) throw new Error("onclave is not initialized");
      const msgId = `msg_${randomId()}`;
      const correlationId = `corr_${randomId()}`;
      const replyMode = params.reply_mode ?? "async_message";
      const remote = await resolveRemotePeer(paths, params);
      const client = await createRemoteClient(bootstrap, paths, remote.endpoint, remote.nodeId, remote.hubInstanceId);
      bootstrap.runtime?.markPeerAuthInProgress?.(remote.nodeId);
      try {
        const response = await client.sendPrompt({
          msgId,
          targetSessionId: params.target_session_id,
          prompt: params.prompt,
          hops: 0,
          replyMode,
          origin: createOriginMetadata({
            bootstrap,
            localSessionId,
            localRegistration,
            correlationId,
          }),
        });
        bootstrap.runtime?.markPeerAuthenticated?.(remote.nodeId);
        await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        if (response.type !== "send_accepted") {
          throw new Error(`remote send failed: ${JSON.stringify(response)}`);
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `onclave_remote_send → ${params.target_session_id}\n` +
                `msg_id ${msgId}\n` +
                `correlation_id ${correlationId}\n` +
                `reply_mode ${replyMode}`,
            },
          ],
          details: {
            msg_id: msgId,
            correlation_id: correlationId,
            reply_mode: replyMode,
            target_session_id: params.target_session_id,
            status: response.status,
            endpoint: remote.endpoint,
          },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
          await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_remote_get",
    label: "Onclave Remote Get",
    description: "Poll a message response from a trusted remote Onclave hub for pollable requests.",
    parameters: Type.Object({
      peer_name: Type.Optional(Type.String({ description: "Name of a static peer in ~/.pi/onclave/config.json." })),
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
        await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        return {
          content: [{ type: "text" as const, text: formatResponseResult(result) }],
          details: { msg_id: params.msg_id, result, endpoint: remote.endpoint },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
          await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        }
        throw error;
      }
    },
  });

  pi.registerTool({
    name: "onclave_reply",
    label: "Onclave Reply",
    description: "Send an asynchronous reply back to the origin host for a received Onclave message.",
    parameters: Type.Object({
      msg_id: Type.Optional(Type.String({ description: "Inbound Onclave msg_id to reply to. Defaults to the latest inbound message with origin metadata." })),
      response: Type.String({ description: "Reply body to send back to the originating host." }),
      status: Type.Optional(
        Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("needs_input")])
      ),
    }),
    async execute(_callId, params) {
      if (!bootstrap || !localSessionId || !localRegistration) throw new Error("onclave is not initialized");
      const inbound = resolveInboundPromptForReply(inboundPrompts, params.msg_id);
      assertAsyncReplyablePrompt({
        msgId: inbound.msgId,
        replyMode: inbound.replyMode,
        origin: inbound.origin,
      });
      const origin = inbound.origin as NonNullable<typeof inbound.origin>;
      const remote = {
        endpoint: origin.endpoint,
        nodeId: origin.nodeId,
        hubInstanceId: origin.hubInstanceId,
      };
      const client = await createRemoteClient(bootstrap, paths, remote.endpoint, remote.nodeId, remote.hubInstanceId);
      const msgId = `msg_${randomId()}`;
      const status = params.status ?? "completed";
      bootstrap.runtime?.markPeerAuthInProgress?.(remote.nodeId);
      try {
        const response = await client.sendPrompt({
          msgId,
          targetSessionId: origin.sessionId,
          prompt: formatAsyncReplyPrompt(inbound, status, params.response),
          hops: 0,
          replyMode: "async_message",
          origin: createOriginMetadata({
            bootstrap,
            localSessionId,
            localRegistration,
            correlationId: origin.correlationId,
            inReplyToMsgId: inbound.msgId,
          }),
        });
        bootstrap.runtime?.markPeerAuthenticated?.(remote.nodeId);
        await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
        if (response.type !== "send_accepted") {
          throw new Error(`onclave reply failed: ${JSON.stringify(response)}`);
        }
        inboundPrompts.delete(inbound.msgId);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `onclave_reply → ${origin.sessionId}\n` +
                `msg_id ${msgId}\n` +
                `in_reply_to ${inbound.msgId}\n` +
                `correlation_id ${origin.correlationId}\n` +
                `status ${status}`,
            },
          ],
          details: {
            msg_id: msgId,
            in_reply_to: inbound.msgId,
            correlation_id: origin.correlationId,
            status,
            endpoint: remote.endpoint,
            target_session_id: origin.sessionId,
          },
        };
      } catch (error) {
        if (error instanceof RemoteHubAuthError) {
          bootstrap.runtime?.markPeerAuthFailed?.(remote.nodeId);
          await refreshOnclaveUi(sessionUi, bootstrap, paths, localRegistration, peerDisplayCache);
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
      const agentList = buildOnclaveAgentList({ heading: "local_agents", agents });
      return {
        content: [{ type: "text" as const, text: agentList.text }],
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
      content: formatInboundPromptMessage(prompt),
      display: true,
      details: {
        msgId: prompt.msgId,
        targetSessionId: prompt.targetSessionId,
        hops: prompt.hops,
        replyMode: prompt.replyMode ?? "pollable",
        origin: prompt.origin,
      },
    },
    { triggerTurn: true, deliverAs: "followUp" }
  );
}

function formatInboundPromptMessage(prompt: DeliveredPrompt): string {
  const lines = ["[inbound onclave message]"];
  if (prompt.origin) {
    lines.push(`[from ${prompt.origin.nodeId} session ${prompt.origin.sessionId}]`);
    lines.push(`[correlation_id ${prompt.origin.correlationId}]`);
    if (prompt.origin.inReplyToMsgId) {
      lines.push(`[in_reply_to ${prompt.origin.inReplyToMsgId}]`);
      lines.push(`[remote reply received; no automatic reply is expected.]`);
    }
  }
  if (prompt.replyMode === "async_message" && !prompt.origin?.inReplyToMsgId) {
    lines.push(`[msg_id ${prompt.msgId}; use onclave_reply when you are ready to respond.]`);
  } else if (prompt.replyMode !== "async_message") {
    lines.push(`[msg_id ${prompt.msgId}; reply with a normal assistant response.]`);
    lines.push("[do not use onclave_reply for this message.]");
  }
  lines.push("", prompt.prompt);
  return lines.join("\n");
}

function latestInboundPrompt(inboundPrompts: Map<string, DeliveredPrompt>): DeliveredPrompt | null {
  return [...inboundPrompts.values()].at(-1) ?? null;
}

function resolveInboundPromptForReply(
  inboundPrompts: Map<string, DeliveredPrompt>,
  msgId?: string
): DeliveredPrompt {
  if (msgId) {
    const prompt = inboundPrompts.get(msgId);
    if (!prompt) throw new Error(`inbound onclave message not found: ${msgId}`);
    return prompt;
  }
  const latestReplyable = [...inboundPrompts.values()]
    .reverse()
    .find((prompt) => Boolean(prompt.origin) && !prompt.origin?.inReplyToMsgId);
  if (!latestReplyable) {
    throw new Error("no inbound Onclave message with reply routing metadata is available");
  }
  return latestReplyable;
}

function formatAsyncReplyPrompt(
  inbound: DeliveredPrompt,
  status: "completed" | "failed" | "needs_input",
  response: string
): string {
  const lines = [
    "[onclave reply]",
    `[status ${status}]`,
  ];
  if (inbound.origin?.correlationId) {
    lines.push(`[correlation_id ${inbound.origin.correlationId}]`);
  }
  lines.push(`[in_reply_to ${inbound.msgId}]`, "", response);
  return lines.join("\n");
}

async function refreshOnclaveUi(
  ui: ExtensionContext["ui"] | null,
  bootstrap: BootstrapLocalHubResult | null,
  paths: ReturnType<typeof getOnclavePaths>,
  localRegistration: LocalAgentRegistration | null,
  peerDisplayCache: Map<string, { model?: string }>
): Promise<void> {
  if (!ui) return;
  if (!bootstrap) {
    ui.setWidget?.("onclave-peers", undefined);
    ui.setStatus?.("onclave", undefined);
    return;
  }

  const peers = bootstrap.runtime?.discoveredPeers?.() ?? [];
  const config = await loadOnclaveConfig(paths).catch(() => ({ version: 1 as const, staticPeers: [] }));
  const peerNames = new Map(config.staticPeers.filter((peer) => peer.name).map((peer) => [peer.nodeId, peer.name as string]));
  const trustedCount = peers.filter((peer) => peer.trustState === "trusted").length;
  const authenticatedCount = peers.filter((peer) => peer.authState === "authenticated").length;
  const widgetPeers = peers.slice(0, 6).map((peer) => ({
    ...peer,
    displayName: peerNames.get(peer.nodeId) ?? shortNodeId(peer.nodeId),
    model: peerDisplayCache.get(peer.nodeId)?.model,
  }));

  ui.setWidget?.(
    "onclave-peers",
    (_tui, theme) => ({
      invalidate() {},
      render(width: number): string[] {
        return renderOnclavePeerWidget(
          width,
          {
            localLabel: widgetLocalLabel(localRegistration, bootstrap.state.nodeId),
            localColor: localRegistration?.color,
            peers: widgetPeers,
          },
          theme
        );
      },
    }),
    { placement: "belowEditor" }
  );
  ui.setStatus?.("onclave", `onclave ${peers.length} peer(s) · ${trustedCount} trusted · ${authenticatedCount} auth`);
}

function cachePeerDisplay(
  peerDisplayCache: Map<string, { model?: string }>,
  nodeId: string,
  agents: Array<{ model: string; status: string }>
): void {
  const preferred = agents.find((agent) => agent.status === "online") ?? agents[0];
  if (!preferred) return;
  peerDisplayCache.set(nodeId, { model: preferred.model });
}

function shortNodeId(nodeId: string): string {
  return nodeId.startsWith("node_") ? nodeId.slice(5, 13) : nodeId.slice(0, 8);
}

function widgetLocalLabel(localRegistration: LocalAgentRegistration | null, nodeId: string): string {
  if (!localRegistration?.name || localRegistration.name.startsWith("agent-")) {
    return shortNodeId(nodeId);
  }
  return localRegistration.name;
}

function createOriginMetadata(input: {
  bootstrap: BootstrapLocalHubResult;
  localSessionId: string;
  localRegistration: LocalAgentRegistration;
  correlationId: string;
  inReplyToMsgId?: string;
}): PromptOriginMetadata {
  return {
    nodeId: input.bootstrap.identity.nodeId,
    hubInstanceId: input.bootstrap.state.hubInstanceId,
    endpoint: choosePreferredRemoteEndpoint(input.bootstrap.state.endpoint, networkInterfaces()),
    sessionId: input.localSessionId,
    correlationId: input.correlationId,
    agentName: input.localRegistration.name,
    projectLabel: input.localRegistration.projectLabel,
    ...(input.inReplyToMsgId ? { inReplyToMsgId: input.inReplyToMsgId } : {}),
  };
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
  paths: ReturnType<typeof getOnclavePaths>,
  params: RemotePeerParams
): Promise<{ endpoint: string; nodeId: string; hubInstanceId: string }> {
  if (params.peer_name) {
    const peer = findStaticPeer(await loadOnclaveConfig(paths), params.peer_name);
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
  paths: ReturnType<typeof getOnclavePaths>,
  endpoint: string,
  nodeId: string,
  hubInstanceId: string
) {
  return createRemoteHubClient({
    identity: {
      nodeId: bootstrap.identity.nodeId,
      hubInstanceId: bootstrap.state.hubInstanceId,
      endpoint: choosePreferredRemoteEndpoint(bootstrap.state.endpoint, networkInterfaces()),
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
