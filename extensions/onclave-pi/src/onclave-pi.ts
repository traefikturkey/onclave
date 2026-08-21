import { hostname } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DELEGATED_ACTIONS,
  PROTOCOL_VERSION,
  buildDelegatedRequestFraming,
  buildFailureReply,
  buildInformDisplayText,
  buildInformReply,
  buildRequestFraming,
  createDelegationGrant,
  createEnvelope,
  ulid,
  verifyDelegationGrant,
  type AgentCard,
  type AgentOrigin,
  type DelegatedAction,
  type DelegationGrant,
  type Envelope,
} from "@onclave/envelope";
import { appendAdapterAuditEvent, type AdapterAuditEventName, type AdapterAuditMetadata } from "./lib/audit";
import { loadApiBaseFromBws } from "./lib/bws";
import { HttpLink, type ConnectionState } from "./lib/connection";
import { CorrelationStore, INBOUND_CUSTOM_TYPE } from "./lib/correlation";
import { SeenIds } from "./lib/dedup";
import { handleInboundHttpDelivery, type DeliveryDeps } from "./lib/delivery";
import { OnclaveHttpClient, resolveApiBase, type Delivery } from "./lib/http-client";
import { loadDefaultRequestSigner } from "./lib/http-signer";
import { isAutoAccepted, loadAdapterPolicy } from "./lib/policy";
import { resolveProjectLabel } from "./lib/project-label";
import { lastAssistantText, runUsage } from "./lib/run-summary";

export { resolveApiBase };

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const LONG_POLL_WAIT_MS = 25_000;
const FOOTER_STATUS_KEY = "onclave-v2";
const ANSI_GREEN = "\x1b[32m";
const ANSI_RED = "\x1b[31m";
const ANSI_RESET = "\x1b[0m";

type AdapterRuntime = {
  card: AgentCard;
  link: HttpLink;
  client: OnclaveHttpClient;
  state: ConnectionState;
  correlation: CorrelationStore;
  seen: SeenIds;
  ui: ExtensionContext["ui"];
  aliveAgents: number;
  registered: boolean;
};

export function isPiSubagent(environment: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    environment.PI_SUBAGENT_RUN_ID?.trim()
      || environment.PI_SUBAGENT_TREE_RUN_ID?.trim()
  );
}

export default function onclavePi(pi: ExtensionAPI): void {
  if (isPiSubagent()) return;

  pi.registerFlag("onclave-id", {
    description: "Override the Onclave v2 agent id (default host-project-session)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("onclave-url", {
    description: "HTTPS API base URL for Onclave",
    type: "string",
    default: undefined,
  });

  const onclaveDir = join(getAgentDir(), "onclave");
  const auditPath = join(onclaveDir, "v2-audit.jsonl");
  const policyPath = join(onclaveDir, "v2-policy.json");
  const audit = (event: AdapterAuditEventName, metadata: AdapterAuditMetadata = {}) =>
    appendAdapterAuditEvent(auditPath, event, metadata);

  let runtime: AdapterRuntime | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const inheritedAgentId = process.env.ONCLAVE_AGENT_ID;
  let exposedAgentId: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    try {
      runtime = await startAdapter(pi, ctx, {
        audit,
        policyPath,
        onRegistered: (agentId) => {
          exposedAgentId = agentId;
          process.env.ONCLAVE_AGENT_ID = agentId;
        },
        onDisconnected: () => {
          if (process.env.ONCLAVE_AGENT_ID === exposedAgentId) {
            if (inheritedAgentId === undefined) delete process.env.ONCLAVE_AGENT_ID;
            else process.env.ONCLAVE_AGENT_ID = inheritedAgentId;
          }
          exposedAgentId = undefined;
        },
      });
      heartbeatTimer = setInterval(() => {
        void heartbeatTick(runtime).catch(() => undefined);
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    } catch (error) {
      ctx.ui.notify(
        `Onclave v2 initialization failed: ${error instanceof Error ? error.message : String(error)}`,
        "error"
      );
    }
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (runtime !== null) {
      await shutdownAdapter(runtime, audit);
      runtime = null;
    }
    if (process.env.ONCLAVE_AGENT_ID === exposedAgentId) {
      if (inheritedAgentId === undefined) delete process.env.ONCLAVE_AGENT_ID;
      else process.env.ONCLAVE_AGENT_ID = inheritedAgentId;
    }
    exposedAgentId = undefined;
  });

  pi.on("agent_end", async (event) => {
    if (runtime === null) return;
    await submitRunReply(runtime, event.messages, audit);
  });

  registerAdapterTools(pi, () => runtime, audit);

  pi.registerCommand("onclave", {
    description: "Show Onclave v2 adapter status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(statusText(runtime), "info");
    },
  });
}

type StartOptions = {
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>;
  policyPath: string;
  onRegistered?: (agentId: string) => void;
  onDisconnected?: () => void;
};

export type ApiBaseLoader = () => Promise<string | undefined>;

export async function resolveAdapterApiBase(
  explicitUrl: string | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  loader: ApiBaseLoader = () => loadApiBaseFromBws(environment)
): Promise<string> {
  if (explicitUrl !== undefined || environment.ONCLAVE_API_BASE !== undefined) {
    return resolveApiBase(explicitUrl, environment);
  }

  const apiBase = await loader();
  if (apiBase === undefined) {
    throw new Error("Onclave BWS bootstrap is missing BITWARDEN_ACCESS_KEY");
  }
  return resolveApiBase(apiBase, {});
}

async function startAdapter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: StartOptions
): Promise<AdapterRuntime> {
  const card = await buildAgentCard(pi, ctx);
  const apiBase = await resolveAdapterApiBase(readStringFlag(pi, "onclave-url"));
  const client = new OnclaveHttpClient({
    apiBase,
    signer: await loadDefaultRequestSigner(),
  });
  const runtime: AdapterRuntime = {
    card,
    link: undefined as unknown as HttpLink,
    client,
    state: "disconnected",
    correlation: new CorrelationStore(),
    seen: new SeenIds(),
    ui: ctx.ui,
    aliveAgents: 0,
    registered: false,
  };
  runtime.link = new HttpLink({
    retryBaseMs: 500,
    retryMaxMs: 15_000,
    onReady: async (signal) => {
      await onHttpReady(runtime, options, signal);
    },
    poll: async (signal) => {
      await pollForDelivery(pi, runtime, options, signal);
    },
    onStateChange: (state, detail) => {
      runtime.state = state;
      if (state === "disconnected") {
        runtime.registered = false;
        options.onDisconnected?.();
        void options.audit("adapter_disconnect", { detail: detail ?? "" });
      }
      refreshFooterStatus(runtime);
    },
  });
  runtime.link.start();
  refreshFooterStatus(runtime);
  return runtime;
}

async function onHttpReady(runtime: AdapterRuntime, options: StartOptions, signal: AbortSignal): Promise<void> {
  const response = await runtime.client.call(
    {
      op: "register",
      protocol_version: PROTOCOL_VERSION,
      card: runtime.card,
    },
    signal
  );
  if (response.ok !== true) {
    const detail = `register rejected: ${String(response.error ?? "unknown")}`;
    runtime.ui.notify(`Onclave v2 ${detail}`, "error");
    throw new Error(detail);
  }
  runtime.registered = true;
  options.onRegistered?.(runtime.card.agent_id);
  await updateAlivePeers(runtime);
  await options.audit("adapter_register", { agent_id: runtime.card.agent_id });
  await options.audit("adapter_connect", { agent_id: runtime.card.agent_id });
}

async function pollForDelivery(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  options: StartOptions,
  signal: AbortSignal
): Promise<void> {
  const delivery = await runtime.client.next(runtime.card.agent_id, LONG_POLL_WAIT_MS, signal);
  if (delivery === undefined) return;
  await consumeDelivery(pi, runtime, delivery, options);
}

async function consumeDelivery(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  delivery: Delivery,
  options: StartOptions
): Promise<void> {
  const deps = buildDeliveryDeps(pi, runtime, options);
  await handleInboundHttpDelivery(deps, delivery.envelope, delivery.deliveryId, (decision) =>
    runtime.client.dispose(delivery.deliveryId, decision)
  );
}

function buildDeliveryDeps(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  options: StartOptions
): DeliveryDeps {
  return {
    localHost: runtime.card.host,
    seen: runtime.seen,
    isAutoAcceptedHost: async (host) => {
      const policy = await loadAdapterPolicy(options.policyPath);
      return isAutoAccepted(policy, host);
    },
    confirmRemote: (envelope) =>
      runtime.ui.confirm(
        "Onclave cross-host request",
        `Agent ${envelope.from.name} [${envelope.from.agent_id}] on host ${envelope.from.host} ` +
          `requests a turn in this session. Allow it to run?`
      ),
    recordExchange: async (envelope) => {
      const response = await requireClient(runtime).call({
        op: "record_exchange",
        conversation_id: envelope.conversation_id,
        message_id: envelope.id,
        performative: envelope.performative,
        from_agent_id: envelope.from.agent_id,
        to_agent_id: envelope.to,
      });
      if (response.ok === true) return { deliver: true };
      return { deliver: false, reason: String(response.error ?? "budget") };
    },
    verifyDelegation: (envelope) => verifyInboundDelegation(envelope, runtime.card),
    deliverTurn: (envelope) => {
      pi.sendMessage(
        {
          customType: INBOUND_CUSTOM_TYPE,
          content: buildRequestFraming(envelope),
          display: true,
          details: inboundDetails(envelope),
        },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    },
    deliverDelegatedTurn: (envelope, grant) => {
      pi.sendMessage(
        {
          customType: INBOUND_CUSTOM_TYPE,
          content: buildDelegatedRequestFraming(envelope),
          display: true,
          details: inboundDetails(envelope, grant),
        },
        { triggerTurn: true, deliverAs: "followUp" }
      );
    },
    deliverInert: (envelope) => {
      pi.sendMessage(
        {
          customType: "onclave-inert",
          content: buildInformDisplayText(envelope),
          display: true,
          details: inboundDetails(envelope),
        },
        { triggerTurn: false }
      );
    },
    publishFailureReply: async (envelope, reason) => {
      const failure = buildFailureReply({
        original: envelope,
        from: cardOrigin(runtime.card),
        body: `request declined: ${reason}`,
      });
      await publishEnvelope(requireClient(runtime), failure);
    },
    publishNotUnderstood: async (replyTo, error) => {
      const target = replyTo.startsWith("agent.") ? replyTo.slice("agent.".length) : replyTo;
      const reply = createEnvelope({
        performative: "not_understood",
        from: cardOrigin(runtime.card),
        to: target,
        body: `message rejected: ${error}`,
      });
      await publishEnvelope(requireClient(runtime), reply);
    },
    registerInbound: (envelope) => runtime.correlation.registerInbound(envelope),
    acceptReply: (envelope) => runtime.correlation.acceptReply(envelope),
    audit: options.audit,
  };
}

function inboundDetails(
  envelope: Envelope,
  grant?: DelegationGrant
): Record<string, unknown> {
  return {
    msgId: envelope.id,
    conversationId: envelope.conversation_id,
    performative: envelope.performative,
    fromAgentId: envelope.from.agent_id,
    fromHost: envelope.from.host,
    ...(grant !== undefined
      ? {
          delegationGrantId: grant.grant_id,
          delegatedActions: grant.actions,
          delegationExpiresAt: grant.expires_at,
        }
      : {}),
  };
}

async function verifyInboundDelegation(
  envelope: Envelope,
  card: AgentCard
): Promise<{ ok: true; grant: DelegationGrant } | { ok: false; reason: string }> {
  const grant = envelope.delegation;
  if (grant === undefined) return { ok: false, reason: "missing_grant" };
  const result = verifyDelegationGrant({
    grant,
    envelope,
    localAgentId: card.agent_id,
    localProject: card.project,
  });
  return result.ok ? result : { ok: false, reason: result.error };
}

async function publishEnvelope(client: OnclaveHttpClient, envelope: Envelope): Promise<void> {
  await client.publish(envelope);
}

function cardOrigin(card: AgentCard): AgentOrigin {
  const origin: AgentOrigin = {
    agent_id: card.agent_id,
    name: card.name,
    host: card.host,
  };
  if (card.project !== undefined) origin.project = card.project;
  return origin;
}

async function submitRunReply(
  runtime: AdapterRuntime,
  messages: unknown[],
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): Promise<void> {
  const inbound = runtime.correlation.matchAgentRun(messages);
  if (inbound === undefined) {
    if (runtime.correlation.inFlightCount() > 0) {
      await audit("correlation_miss", { in_flight: runtime.correlation.inFlightCount() });
    }
    return;
  }
  if (!runtime.registered || runtime.state !== "connected") {
    await audit("correlation_miss", { message_id: inbound.id, detail: "HTTPS transport disconnected" });
    return;
  }
  const reply = buildInformReply({
    original: inbound,
    from: cardOrigin(runtime.card),
    body: lastAssistantText(messages),
    usage: runUsage(messages),
  });
  await publishEnvelope(runtime.client, reply);
  runtime.correlation.completeInbound(inbound.id);
  await audit("reply_published", {
    message_id: reply.id,
    in_reply_to: inbound.id,
    conversation_id: reply.conversation_id,
  });
}

async function heartbeatTick(runtime: AdapterRuntime | null): Promise<void> {
  if (runtime === null || !runtime.registered || runtime.state !== "connected") return;
  await runtime.client.call({ op: "heartbeat", agent_id: runtime.card.agent_id });
  await updateAlivePeers(runtime);
}

async function updateAlivePeers(runtime: AdapterRuntime): Promise<void> {
  const list = await runtime.client.call({ op: "list_agents" });
  if (list.ok === true && Array.isArray(list.agents)) {
    runtime.aliveAgents = (list.agents as Array<{ agent_id?: unknown; alive?: unknown }>).filter(
      (agent) => agent.alive === true && agent.agent_id !== runtime.card.agent_id
    ).length;
  }
  refreshFooterStatus(runtime);
}

async function shutdownAdapter(
  runtime: AdapterRuntime,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): Promise<void> {
  try {
    if (runtime.registered && runtime.state === "connected") {
      await runtime.client.call({ op: "unregister", agent_id: runtime.card.agent_id });
      await audit("adapter_unregister", { agent_id: runtime.card.agent_id });
    }
  } catch {
    // The HTTPS transport may already be unavailable; shutdown continues.
  }
  await runtime.link.stop();
  runtime.ui.setStatus?.(FOOTER_STATUS_KEY, undefined);
  runtime.correlation.clear();
}

type FooterStatusRuntime = Pick<AdapterRuntime, "aliveAgents" | "card" | "state" | "ui">;

export function refreshFooterStatus(runtime: FooterStatusRuntime): void {
  const clientColor = runtime.state === "connected" ? ANSI_GREEN : ANSI_RED;
  const line = `Onclave[${runtime.aliveAgents}]: ${clientColor}${runtime.card.agent_id}${ANSI_RESET}`;
  runtime.ui.setStatus?.(FOOTER_STATUS_KEY, line);
}

function statusText(runtime: AdapterRuntime | null): string {
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  if (runtime === null) return "Onclave v2 adapter is not initialized";
  return (
    `state: ${runtime.state}\n` +
    `agent_id: ${runtime.card.agent_id}\n` +
    `registered: ${runtime.registered}\n` +
    `peers alive: ${runtime.aliveAgents}`
  );
}

async function buildAgentCard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<AgentCard> {
  const project = await resolveProjectLabel(ctx.cwd || process.cwd());
  const host = hostname();
  const flagId = readStringFlag(pi, "onclave-id");
  const agentId = flagId === undefined
    ? sessionAgentId(ctx.sessionManager.getSessionId())
    : sanitizeAgentId(flagId);
  const card: AgentCard = {
    agent_id: agentId,
    name: pi.getSessionName?.() ?? agentId,
    host,
    project,
    transport: "https",
  };
  const model = ctx.model?.id;
  if (typeof model === "string" && model.length > 0) card.model = model;
  return card;
}

function sessionAgentId(sessionId: string): string {
  const suffix = sanitizeAgentId(sessionId).replaceAll("-", "").slice(0, 12);
  return `pi-${suffix}`;
}

function sanitizeAgentId(value: string): string {
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "onclave-agent";
}

function readStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireClient(runtime: AdapterRuntime): OnclaveHttpClient {
  if (!runtime.registered || runtime.state !== "connected") {
    throw new Error("onclave HTTPS transport is disconnected");
  }
  return runtime.client;
}

type RuntimeGetter = () => AdapterRuntime | null;

function requireRuntime(getRuntime: RuntimeGetter): AdapterRuntime {
  const runtime = getRuntime();
  if (runtime === null) throw new Error("onclave v2 adapter is not initialized");
  return runtime;
}

function textResult(text: string, details: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

function registerAdapterTools(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): void {
  registerListTool(pi, getRuntime);
  registerSendTool(pi, getRuntime);
  registerDelegateTool(pi, getRuntime, audit);
  registerInformTool(pi, getRuntime, audit);
  registerGetTool(pi, getRuntime);
  registerAwaitTool(pi, getRuntime);
}

function registerListTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "onclave_agents",
    label: "Onclave Agents",
    description: "List live agents registered with the Onclave core, optionally including stale registrations.",
    parameters: Type.Object({
      include_stale: Type.Optional(Type.Boolean({ description: "Include stale registrations for diagnostics" })),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const response = await requireClient(runtime).call({
        op: "list_agents",
        ...(params.include_stale === true ? { include_stale: true } : {}),
      });
      if (response.ok !== true) throw new Error(`list_agents failed: ${String(response.error)}`);
      const agents = response.agents as Array<Record<string, unknown>>;
      const lines = agents.map(
        (agent) =>
          `${String(agent.agent_id)} (${String(agent.name)}) host=${String(agent.host)}` +
          ` project=${String(agent.project ?? "-")} alive=${String(agent.alive)}`
      );
      return textResult(lines.length > 0 ? lines.join("\n") : "no agents registered", { agents });
    },
  });
}

function registerSendTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "onclave_send",
    label: "Onclave Send",
    description:
      "Send a request or query envelope to another Onclave agent. Returns the message id for onclave_get / onclave_await.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id (see onclave_agents).", maxLength: 256 }),
      body: Type.String({ description: "Message body to deliver.", maxLength: MAX_MESSAGE_LENGTH }),
      performative: Type.Optional(StringEnum(["request", "query"] as const)),
      conversation_id: Type.Optional(
        Type.String({ description: "Continue an existing conversation." })
      ),
      ttl_ms: Type.Optional(
        Type.Integer({ description: "Message TTL in milliseconds.", minimum: 1000 })
      ),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const envelope = createEnvelope({
        performative: params.performative ?? "request",
        from: cardOrigin(runtime.card),
        to: params.to,
        body: params.body,
        conversationId: params.conversation_id,
        ttlMs: params.ttl_ms,
      });
      runtime.correlation.registerOutbound(envelope);
      await publishEnvelope(requireClient(runtime), envelope);
      return textResult(
        `onclave_send -> ${params.to}\nmsg_id ${envelope.id}\nconversation_id ${envelope.conversation_id}`,
        {
          msg_id: envelope.id,
          conversation_id: envelope.conversation_id,
          to: params.to,
          performative: envelope.performative,
        }
      );
    },
  });
}

function registerDelegateTool(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): void {
  pi.registerTool({
    name: "onclave_delegate",
    label: "Onclave Delegate",
    description:
      "Send a scoped, expiring delegation request to another registered Onclave agent.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent id (see onclave_agents).", maxLength: 256 }),
      body: Type.String({ description: "Exact delegated request body.", maxLength: MAX_MESSAGE_LENGTH }),
      scope: Type.String({ description: "Concise boundary for the delegated work.", minLength: 1, maxLength: 2_000 }),
      actions: Type.Array(StringEnum(DELEGATED_ACTIONS), {
        description: "Authorized action classes.",
        minItems: 1,
        maxItems: DELEGATED_ACTIONS.length,
      }),
      ttl_minutes: Type.Optional(
        Type.Integer({ description: "Authorization lifetime in minutes.", minimum: 1, maximum: 1_440 })
      ),
      conversation_id: Type.Optional(
        Type.String({ description: "Continue an existing conversation." })
      ),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const target = await resolveDelegationTarget(runtime, params.to);
      const actions = [...new Set(params.actions)] as DelegatedAction[];
      const ttlMinutes = params.ttl_minutes ?? 30;
      return publishDelegation(runtime, target, params.body, actions, params, ttlMinutes, audit);
    },
  });
}

type DelegationTarget = { agent_id: string; project?: string };

async function publishDelegation(
  runtime: AdapterRuntime,
  target: DelegationTarget,
  body: string,
  actions: DelegatedAction[],
  params: { scope: string; conversation_id?: string },
  ttlMinutes: number,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
) {
  const conversationId = params.conversation_id ?? ulid();
  const grant = createDelegationGrant({
    issuerAgentId: runtime.card.agent_id,
    issuerProject: runtime.card.project,
    audienceAgentId: target.agent_id,
    audienceProject: target.project,
    conversationId,
    body,
    actions,
    scope: params.scope,
    ttlMs: ttlMinutes * 60_000,
  });
  const envelope = createEnvelope({
    performative: "request",
    from: cardOrigin(runtime.card),
    to: target.agent_id,
    body,
    conversationId,
    ttlMs: ttlMinutes * 60_000,
    delegation: grant,
  });
  runtime.correlation.registerOutbound(envelope);
  await publishEnvelope(requireClient(runtime), envelope);
  await audit("delegation_issued", {
    message_id: envelope.id,
    grant_id: grant.grant_id,
    to_agent_id: target.agent_id,
    actions,
    expires_at: grant.expires_at,
  });
  return textResult(
    `onclave_delegate -> ${target.agent_id}\nmsg_id ${envelope.id}\n` +
      `conversation_id ${envelope.conversation_id}\ngrant_id ${grant.grant_id}\n` +
      `expires_at ${grant.expires_at}`,
    {
      msg_id: envelope.id,
      conversation_id: envelope.conversation_id,
      grant_id: grant.grant_id,
      to: target.agent_id,
      actions,
      expires_at: grant.expires_at,
    }
  );
}

async function resolveDelegationTarget(
  runtime: AdapterRuntime,
  agentId: string
): Promise<DelegationTarget> {
  const response = await requireClient(runtime).call({ op: "list_agents" });
  if (response.ok !== true || !Array.isArray(response.agents)) {
    throw new Error(`list_agents failed: ${String(response.error ?? "invalid response")}`);
  }
  const target = (response.agents as Array<Record<string, unknown>>).find(
    (agent) => agent.agent_id === agentId
  );
  if (target === undefined) throw new Error(`Onclave target agent is not registered: ${agentId}`);
  const project = typeof target.project === "string" ? target.project : undefined;
  return { agent_id: agentId, ...(project === undefined ? {} : { project }) };
}

function registerInformTool(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): void {
  pi.registerTool({
    name: "onclave_inform",
    label: "Onclave Inform",
    description: "Send an inert inform notification to one agent or all alive peers. Informs never trigger turns.",
    parameters: Type.Object({
      body: Type.String({ description: "Notification body.", maxLength: MAX_MESSAGE_LENGTH }),
      to: Type.Optional(
        Type.String({ description: "Target agent id. Omit to inform all alive peers." })
      ),
      conversation_id: Type.Optional(
        Type.String({ description: "Attach to an existing conversation." })
      ),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      if (params.to !== undefined) {
        const envelope = createEnvelope({
          performative: "inform",
          from: cardOrigin(runtime.card),
          to: params.to,
          body: params.body,
          conversationId: params.conversation_id,
        });
        await publishEnvelope(requireClient(runtime), envelope);
        await audit("inform_published", {
          message_id: envelope.id,
          to: params.to,
        });
        return textResult(`onclave_inform sent\nmsg_id ${envelope.id}`, {
          msg_id: envelope.id,
          to: params.to,
        });
      }

      const client = requireClient(runtime);
      const response = await client.call({ op: "list_agents" });
      const recipients = alivePeerAgentIds(response, runtime.card.agent_id);
      const messages = recipients.map((to) =>
        createEnvelope({
          performative: "inform",
          from: cardOrigin(runtime.card),
          to,
          body: params.body,
          conversationId: params.conversation_id,
        })
      );
      for (const envelope of messages) {
        await publishEnvelope(client, envelope);
        await audit("inform_published", {
          message_id: envelope.id,
          to: envelope.to,
        });
      }
      return textResult(`onclave_inform broadcast\nrecipients ${recipients.length}`, {
        recipient_count: recipients.length,
        recipients,
        msg_ids: messages.map((message) => message.id),
      });
    },
  });
}

function alivePeerAgentIds(response: Record<string, unknown>, localAgentId: string): string[] {
  if (response.ok !== true || !Array.isArray(response.agents)) {
    throw new Error(`list_agents failed: ${String(response.error ?? "invalid response")}`);
  }
  const recipients = new Set<string>();
  for (const agent of response.agents) {
    if (agent === null || typeof agent !== "object" || Array.isArray(agent)) continue;
    const { agent_id: agentId, alive } = agent as Record<string, unknown>;
    if (
      typeof agentId === "string" &&
      agentId.length > 0 &&
      agentId !== localAgentId &&
      agentId !== "*" &&
      alive === true
    ) {
      recipients.add(agentId);
    }
  }
  return [...recipients];
}

function formatReply(reply: Envelope | undefined, msgId: string): string {
  if (reply === undefined) return "pending";
  return `${reply.performative} from ${reply.from.agent_id}:\n${reply.body}`;
}

function registerGetTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "onclave_get",
    label: "Onclave Get",
    description: "Check for a reply to a message sent with onclave_send.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message id returned by onclave_send." }),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const reply = runtime.correlation.getReply(params.msg_id);
      return textResult(formatReply(reply, params.msg_id), {
        msg_id: params.msg_id,
        status: reply === undefined ? "pending" : "complete",
        reply,
      });
    },
  });
}

function registerAwaitTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "onclave_await",
    label: "Onclave Await",
    description: "Wait for a reply to a message sent with onclave_send, until timeout.",
    parameters: Type.Object({
      msg_id: Type.String({ description: "Message id returned by onclave_send." }),
      timeout_ms: Type.Optional(
        Type.Integer({ minimum: 1, maximum: MAX_WAIT_TIMEOUT_MS })
      ),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const timeoutMs = Math.min(params.timeout_ms ?? 30_000, MAX_WAIT_TIMEOUT_MS);
      const deadline = Date.now() + timeoutMs;
      let reply = runtime.correlation.getReply(params.msg_id);
      while (reply === undefined && Date.now() < deadline) {
        await sleep(250);
        reply = runtime.correlation.getReply(params.msg_id);
      }
      return textResult(formatReply(reply, params.msg_id), {
        msg_id: params.msg_id,
        status: reply === undefined ? "timeout" : "complete",
        reply,
      });
    },
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
