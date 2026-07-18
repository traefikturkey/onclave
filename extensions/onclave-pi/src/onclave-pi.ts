import { hostname } from "node:os";
import { join } from "node:path";
import { connect } from "amqplib";
import type { Channel } from "amqplib";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  EXCHANGE_AGENTS,
  EXCHANGE_EVENTS,
  PROTOCOL_VERSION,
  buildInformDisplayText,
  buildInformReply,
  buildFailureReply,
  buildRequestFraming,
  createEnvelope,
  toAmqpPublish,
  type AgentCard,
  type AgentOrigin,
  type Envelope,
  type TokenUsage,
} from "@onclave/envelope";
import { appendAdapterAuditEvent, type AdapterAuditEventName, type AdapterAuditMetadata } from "./lib/audit";
import { BrokerLink, type ConnectionState } from "./lib/connection";
import { CorrelationStore, INBOUND_CUSTOM_TYPE } from "./lib/correlation";
import { SeenIds } from "./lib/dedup";
import { handleInboundMessage, type DeliveryDeps } from "./lib/delivery";
import { isAutoAccepted, loadAdapterPolicy } from "./lib/policy";
import { resolveProjectLabel } from "./lib/project-label";
import { CoreRpcClient } from "./lib/rpc-client";
import { lastAssistantText, runUsage } from "./lib/run-summary";

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_WAIT_TIMEOUT_MS = 300_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_AMQP_URL = "amqp://onclave:onclave-dev@localhost:5672/onclave";

type AdapterRuntime = {
  card: AgentCard;
  queue: string;
  link: BrokerLink;
  channel: Channel | undefined;
  rpc: CoreRpcClient | undefined;
  state: ConnectionState;
  correlation: CorrelationStore;
  seen: SeenIds;
  ui: ExtensionContext["ui"];
  aliveAgents: number;
  registered: boolean;
};

export default function onclavePi(pi: ExtensionAPI): void {
  pi.registerFlag("onclave-id", {
    description: "Override the Onclave v2 agent id (default host-project)",
    type: "string",
    default: undefined,
  });
  pi.registerFlag("onclave-url", {
    description: "AMQP URL for the Onclave broker",
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

  pi.on("session_start", async (_event, ctx) => {
    try {
      runtime = await startAdapter(pi, ctx, { audit, policyPath });
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
};

async function startAdapter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: StartOptions
): Promise<AdapterRuntime> {
  const card = await buildAgentCard(pi, ctx);
  const runtime: AdapterRuntime = {
    card,
    queue: `agent.${card.agent_id}`,
    link: undefined as unknown as BrokerLink,
    channel: undefined,
    rpc: undefined,
    state: "disconnected",
    correlation: new CorrelationStore(),
    seen: new SeenIds(),
    ui: ctx.ui,
    aliveAgents: 0,
    registered: false,
  };
  const url = amqpUrl(pi);
  runtime.link = new BrokerLink({
    url,
    connectFn: connect as unknown as ConstructorParameters<typeof BrokerLink>[0]["connectFn"],
    retryBaseMs: 500,
    retryMaxMs: 15000,
    onReady: async (channel) => {
      await onChannelReady(pi, runtime, channel as Channel, options);
    },
    onStateChange: (state, detail) => {
      runtime.state = state;
      if (state === "disconnected") {
        runtime.channel = undefined;
        runtime.rpc?.failAll("broker disconnected");
        runtime.rpc = undefined;
        runtime.registered = false;
        void options.audit("adapter_disconnect", { detail: detail ?? "" });
      }
      refreshWidget(runtime);
    },
  });
  runtime.link.start();
  refreshWidget(runtime);
  return runtime;
}

async function onChannelReady(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  channel: Channel,
  options: StartOptions
): Promise<void> {
  runtime.channel = channel;
  const rpc = new CoreRpcClient(channel);
  await rpc.init();
  runtime.rpc = rpc;
  const response = await rpc.call({
    op: "register",
    protocol_version: PROTOCOL_VERSION,
    card: runtime.card,
  });
  if (response.ok !== true) {
    const detail = `register rejected: ${String(response.error ?? "unknown")}`;
    runtime.ui.notify(`Onclave v2 ${detail}`, "error");
    throw new Error(detail);
  }
  runtime.registered = true;
  await options.audit("adapter_register", {
    agent_id: runtime.card.agent_id,
    queue: runtime.queue,
  });
  await channel.consume(runtime.queue, (message) => {
    if (message === null) return;
    void consumeMessage(pi, runtime, channel, message, options);
  });
  await options.audit("adapter_connect", { agent_id: runtime.card.agent_id });
  refreshWidget(runtime);
}

async function consumeMessage(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  channel: Channel,
  message: Parameters<Parameters<Channel["consume"]>[1]>[0] & object,
  options: StartOptions
): Promise<void> {
  try {
    const deps = buildDeliveryDeps(pi, runtime, channel, options);
    const decision = await handleInboundMessage(deps, message);
    if (decision === "ack") {
      channel.ack(message);
    } else {
      channel.reject(message, false);
    }
  } catch (error) {
    await options
      .audit("message_rejected", {
        detail: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    channel.reject(message, false);
  }
}

function buildDeliveryDeps(
  pi: ExtensionAPI,
  runtime: AdapterRuntime,
  channel: Channel,
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
      const rpc = requireRpc(runtime);
      const response = await rpc.call({
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
    publishFailureReply: (envelope, reason) => {
      const failure = buildFailureReply({
        original: envelope,
        from: cardOrigin(runtime.card),
        body: `request declined: ${reason}`,
      });
      publishEnvelope(channel, failure);
    },
    publishNotUnderstood: (replyTo, error) => {
      publishNotUnderstoodTo(channel, runtime.card, replyTo, error);
    },
    registerInbound: (envelope) => runtime.correlation.registerInbound(envelope),
    acceptReply: (envelope) => runtime.correlation.acceptReply(envelope),
    audit: options.audit,
  };
}

function inboundDetails(envelope: Envelope): Record<string, unknown> {
  return {
    msgId: envelope.id,
    conversationId: envelope.conversation_id,
    performative: envelope.performative,
    fromAgentId: envelope.from.agent_id,
    fromHost: envelope.from.host,
  };
}

function publishEnvelope(channel: Channel, envelope: Envelope): void {
  const spec = toAmqpPublish(envelope);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
}

function publishNotUnderstoodTo(
  channel: Channel,
  card: AgentCard,
  replyTo: string,
  error: string
): void {
  const target = replyTo.startsWith("agent.") ? replyTo.slice("agent.".length) : replyTo;
  const reply = createEnvelope({
    performative: "not_understood",
    from: cardOrigin(card),
    to: target,
    body: `message rejected: ${error}`,
  });
  const spec = toAmqpPublish(reply);
  channel.sendToQueue(replyTo, spec.content, spec.options);
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
  const channel = runtime.channel;
  if (channel === undefined) {
    await audit("correlation_miss", { message_id: inbound.id, detail: "broker disconnected" });
    return;
  }
  const reply = buildInformReply({
    original: inbound,
    from: cardOrigin(runtime.card),
    body: lastAssistantText(messages),
    usage: runUsage(messages),
  });
  publishEnvelope(channel, reply);
  runtime.correlation.completeInbound(inbound.id);
  await audit("reply_published", {
    message_id: reply.id,
    in_reply_to: inbound.id,
    conversation_id: reply.conversation_id,
  });
}

async function heartbeatTick(runtime: AdapterRuntime | null): Promise<void> {
  if (runtime === null || runtime.rpc === undefined || !runtime.registered) return;
  await runtime.rpc.call({ op: "heartbeat", agent_id: runtime.card.agent_id });
  const list = await runtime.rpc.call({ op: "list_agents" });
  if (list.ok === true && Array.isArray(list.agents)) {
    runtime.aliveAgents = (list.agents as Array<{ alive?: unknown }>).filter(
      (agent) => agent.alive === true
    ).length;
  }
  refreshWidget(runtime);
}

async function shutdownAdapter(
  runtime: AdapterRuntime,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): Promise<void> {
  try {
    if (runtime.rpc !== undefined && runtime.registered) {
      await runtime.rpc.call({ op: "unregister", agent_id: runtime.card.agent_id });
      await audit("adapter_unregister", { agent_id: runtime.card.agent_id });
    }
  } catch {
    // broker may already be gone; shutdown continues
  }
  await runtime.link.stop();
  runtime.ui.setWidget?.("onclave-v2", undefined);
  runtime.correlation.clear();
}

function refreshWidget(runtime: AdapterRuntime): void {
  const line =
    `onclave v2 ${runtime.state}` +
    ` | ${runtime.card.agent_id}` +
    ` | peers alive: ${runtime.aliveAgents}`;
  runtime.ui.setWidget?.("onclave-v2", [line], { placement: "belowEditor" });
}

function statusText(runtime: AdapterRuntime | null): string {
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  if (runtime === null) return "Onclave v2 adapter is not initialized";
  return (
    `state: ${runtime.state}\n` +
    `agent_id: ${runtime.card.agent_id}\n` +
    `queue: ${runtime.queue}\n` +
    `registered: ${runtime.registered}\n` +
    `peers alive: ${runtime.aliveAgents}`
  );
}

async function buildAgentCard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<AgentCard> {
  const project = await resolveProjectLabel(ctx.cwd || process.cwd());
  const host = hostname();
  const flagId = readStringFlag(pi, "onclave-id");
  const agentId = sanitizeAgentId(flagId ?? `${host}-${project}`);
  const card: AgentCard = {
    agent_id: agentId,
    name: pi.getSessionName?.() ?? agentId,
    host,
    project,
    transport: "amqp",
  };
  const model = ctx.model?.id;
  if (typeof model === "string" && model.length > 0) card.model = model;
  return card;
}

function sanitizeAgentId(value: string): string {
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned.slice(0, 64) || "onclave-agent";
}

function amqpUrl(pi: ExtensionAPI): string {
  return readStringFlag(pi, "onclave-url") ?? process.env.ONCLAVE_AMQP_URL ?? DEFAULT_AMQP_URL;
}

function readStringFlag(pi: ExtensionAPI, name: string): string | undefined {
  const value = pi.getFlag(name);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireRpc(runtime: AdapterRuntime): CoreRpcClient {
  if (runtime.rpc === undefined) throw new Error("onclave core rpc is unavailable");
  return runtime.rpc;
}

type RuntimeGetter = () => AdapterRuntime | null;

function requireRuntime(getRuntime: RuntimeGetter): AdapterRuntime {
  const runtime = getRuntime();
  if (runtime === null) throw new Error("onclave v2 adapter is not initialized");
  return runtime;
}

function requireChannel(runtime: AdapterRuntime): Channel {
  if (runtime.channel === undefined) throw new Error("onclave broker is disconnected");
  return runtime.channel;
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
  registerInformTool(pi, getRuntime, audit);
  registerGetTool(pi, getRuntime);
  registerAwaitTool(pi, getRuntime);
}

function registerListTool(pi: ExtensionAPI, getRuntime: RuntimeGetter): void {
  pi.registerTool({
    name: "onclave_agents",
    label: "Onclave Agents",
    description: "List agents registered with the Onclave core, with liveness.",
    parameters: Type.Object({}),
    async execute() {
      const runtime = requireRuntime(getRuntime);
      const response = await requireRpc(runtime).call({ op: "list_agents" });
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
      const channel = requireChannel(runtime);
      const envelope = createEnvelope({
        performative: params.performative ?? "request",
        from: cardOrigin(runtime.card),
        to: params.to,
        body: params.body,
        conversationId: params.conversation_id,
        ttlMs: params.ttl_ms,
      });
      runtime.correlation.registerOutbound(envelope);
      publishEnvelope(channel, envelope);
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

function registerInformTool(
  pi: ExtensionAPI,
  getRuntime: RuntimeGetter,
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>
): void {
  pi.registerTool({
    name: "onclave_inform",
    label: "Onclave Inform",
    description:
      "Send an inert inform notification to one agent, or broadcast to the events exchange when no target is given. Informs never trigger turns.",
    parameters: Type.Object({
      body: Type.String({ description: "Notification body.", maxLength: MAX_MESSAGE_LENGTH }),
      to: Type.Optional(Type.String({ description: "Target agent id; omit to broadcast." })),
      conversation_id: Type.Optional(
        Type.String({ description: "Attach to an existing conversation." })
      ),
    }),
    async execute(_callId, params) {
      const runtime = requireRuntime(getRuntime);
      const channel = requireChannel(runtime);
      const envelope = createEnvelope({
        performative: "inform",
        from: cardOrigin(runtime.card),
        to: params.to ?? "*",
        body: params.body,
        conversationId: params.conversation_id,
      });
      const spec = toAmqpPublish(envelope);
      if (params.to !== undefined) {
        channel.publish(EXCHANGE_AGENTS, params.to, spec.content, spec.options);
      } else {
        const topic = `inform.${runtime.card.project ?? "default"}.${runtime.card.agent_id}`;
        channel.publish(EXCHANGE_EVENTS, topic, spec.content, spec.options);
      }
      await audit("inform_published", {
        message_id: envelope.id,
        to: params.to ?? "broadcast",
      });
      return textResult(`onclave_inform sent\nmsg_id ${envelope.id}`, {
        msg_id: envelope.id,
        to: params.to ?? "broadcast",
      });
    },
  });
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
