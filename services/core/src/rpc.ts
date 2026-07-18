import type { Channel, ConsumeMessage } from "amqplib";
import {
  EXCHANGE_AGENTS,
  EXCHANGE_DLX,
  PROTOCOL_VERSION,
  QUEUE_CORE_RPC,
  agentQueueName,
  createEnvelope,
  parseRpcRequest,
  toAmqpPublish,
  type Envelope,
  type RpcRequest,
} from "@onclave/envelope";
import type { AuditEventName, AuditMetadata } from "./audit";
import type { ConversationStore } from "./conversations";
import type { Registry } from "./registry";
import type { CoreConfig } from "./config";
import { coreOrigin } from "./core-origin";
import { log } from "./log";

export type AuditFn = (event: AuditEventName, metadata?: AuditMetadata) => Promise<void>;

export type CoreServices = {
  config: CoreConfig;
  registry: Registry;
  conversations: ConversationStore;
  audit: AuditFn;
};

export function agentQueueArguments(config: CoreConfig): Record<string, unknown> {
  return {
    "x-dead-letter-exchange": EXCHANGE_DLX,
    "x-message-ttl": config.queueTtlMs,
    "x-max-length": config.queueMaxLength,
  };
}

export function publishEnvelope(channel: Channel, envelope: Envelope): void {
  const spec = toAmqpPublish(envelope);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
}

async function handleRegister(
  services: CoreServices,
  channel: Channel,
  request: Extract<RpcRequest, { op: "register" }>
): Promise<object> {
  if (request.protocol_version !== PROTOCOL_VERSION) {
    await services.audit("agent_register_rejected", {
      agent_id: request.card.agent_id,
      reason: "protocol_version_mismatch",
      offered: request.protocol_version,
      expected: PROTOCOL_VERSION,
    });
    return {
      ok: false,
      error: "protocol_version_mismatch",
      expected: PROTOCOL_VERSION,
    };
  }
  const queue = agentQueueName(request.card.agent_id);
  await channel.assertQueue(queue, {
    durable: true,
    arguments: agentQueueArguments(services.config),
  });
  await channel.bindQueue(queue, EXCHANGE_AGENTS, request.card.agent_id);
  const agent = await services.registry.register(request.card);
  await services.audit("agent_register", {
    agent_id: agent.agent_id,
    host: agent.host,
    queue,
  });
  return { ok: true, agent, queue, protocol_version: PROTOCOL_VERSION };
}

async function handleRecordExchange(
  services: CoreServices,
  channel: Channel,
  request: Extract<RpcRequest, { op: "record_exchange" }>
): Promise<object> {
  const result = await services.conversations.recordExchange({
    conversationId: request.conversation_id,
    performative: request.performative,
    fromAgentId: request.from_agent_id,
    toAgentId: request.to_agent_id,
    ...(request.usage !== undefined ? { usage: request.usage } : {}),
  });
  await services.audit("conversation_exchange", {
    conversation_id: request.conversation_id,
    message_id: request.message_id,
    performative: request.performative,
    from_agent_id: request.from_agent_id,
    to_agent_id: request.to_agent_id,
    exchanges: result.state.exchanges,
    usage_total: result.state.usage_total,
  });
  if (!result.ok) {
    await terminateConversation(services, channel, request, result.reason);
    return { ok: false, error: result.reason, state: result.state };
  }
  if (result.advisory !== undefined) {
    await services.audit("conversation_budget_advisory", {
      conversation_id: request.conversation_id,
      advisory: result.advisory,
      usage_total: result.state.usage_total,
    });
  }
  return { ok: true, state: result.state, ...(result.advisory ? { advisory: result.advisory } : {}) };
}

async function terminateConversation(
  services: CoreServices,
  channel: Channel,
  request: Extract<RpcRequest, { op: "record_exchange" }>,
  reason: string
): Promise<void> {
  const participants = services.conversations.get(request.conversation_id)?.participants ?? [
    request.from_agent_id,
    request.to_agent_id,
  ];
  for (const participant of participants) {
    const failure = createEnvelope({
      performative: "failure",
      from: coreOrigin(),
      to: participant,
      body: `conversation ${request.conversation_id} terminated: ${reason}`,
      conversationId: request.conversation_id,
    });
    publishEnvelope(channel, failure);
  }
  await services.audit("conversation_terminated", {
    conversation_id: request.conversation_id,
    reason,
    participants,
  });
}

type SimpleRpcRequest = Exclude<RpcRequest, { op: "register" } | { op: "record_exchange" }>;

async function handleSimpleOps(services: CoreServices, request: SimpleRpcRequest): Promise<object> {
  if (request.op === "heartbeat") {
    const known = await services.registry.heartbeat(request.agent_id);
    return known ? { ok: true } : { ok: false, error: "unknown_agent" };
  }
  if (request.op === "unregister") {
    const removed = await services.registry.unregister(request.agent_id);
    await services.audit("agent_unregister", { agent_id: request.agent_id, removed });
    return { ok: true, removed };
  }
  if (request.op === "list_agents") {
    return { ok: true, agents: services.registry.list() };
  }
  const state = services.conversations.get(request.conversation_id);
  if (state === undefined) {
    return { ok: false, error: "unknown_conversation" };
  }
  return { ok: true, state };
}

export async function handleRpcRequest(
  services: CoreServices,
  channel: Channel,
  request: RpcRequest
): Promise<object> {
  switch (request.op) {
    case "register":
      return handleRegister(services, channel, request);
    case "record_exchange":
      return handleRecordExchange(services, channel, request);
    default:
      return handleSimpleOps(services, request);
  }
}

function parseRpcMessage(message: ConsumeMessage): ReturnType<typeof parseRpcRequest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content.toString("utf8"));
  } catch {
    return { ok: false, error: "rpc request is not valid JSON" };
  }
  return parseRpcRequest(parsed);
}

export async function startRpcServer(services: CoreServices, channel: Channel): Promise<void> {
  await channel.consume(QUEUE_CORE_RPC, (message) => {
    if (message === null) return;
    void serveRpcMessage(services, channel, message);
  });
  log("info", "rpc.listening", { queue: QUEUE_CORE_RPC });
}

async function serveRpcMessage(
  services: CoreServices,
  channel: Channel,
  message: ConsumeMessage
): Promise<void> {
  let response: object;
  const parsed = parseRpcMessage(message);
  if (parsed.ok) {
    try {
      response = await handleRpcRequest(services, channel, parsed.request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("error", "rpc.handler_failed", { message: detail });
      response = { ok: false, error: "internal_error" };
    }
  } else {
    await services.audit("rpc_rejected", { reason: parsed.error });
    response = { ok: false, error: parsed.error };
  }
  replyToRpc(channel, message, response);
  channel.ack(message);
}

function replyToRpc(channel: Channel, message: ConsumeMessage, response: object): void {
  const replyTo = message.properties.replyTo;
  if (typeof replyTo !== "string" || replyTo === "") return;
  channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(response), "utf8"), {
    correlationId: message.properties.correlationId,
    contentType: "application/json",
  });
}
