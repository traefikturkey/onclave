import type { Channel as AmqpChannel, ConsumeMessage } from "amqplib";
import {
  EXCHANGE_AGENTS,
  EXCHANGE_DLX,
  PROTOCOL_VERSION,
  QUEUE_CORE_RPC,
  agentQueueName,
  parseRpcRequest,
  toChannelMessagePublish,
  toTaskStatusPublish,
  type A2AOrigin,
  type ChannelMessage,
  type ChannelPostRpcRequest,
  type ChannelSatisfaction,
  type RpcRequest,
  type TaskStatusEvent,
} from "@onclave/envelope";
import type { AuditEventName, AuditMetadata } from "./audit";
import type { ChannelPostInput, ChannelPostResult, ChannelStore } from "./channel-store";
import type { TaskStore } from "./tasks";
import type { Registry, RegisteredAgent } from "./registry";
import type { CoreConfig } from "./config";
import { coreOrigin, CORE_AGENT_ID } from "./core-origin";
import { log } from "./log";

export type AuditFn = (event: AuditEventName, metadata?: AuditMetadata) => Promise<void>;

export type CoreServices = {
  config: CoreConfig;
  registry: Registry;
  channels?: ChannelStore;
  tasks?: TaskStore;
  audit: AuditFn;
};

export function agentQueueArguments(config: CoreConfig): Record<string, unknown> {
  return {
    "x-dead-letter-exchange": EXCHANGE_DLX,
    "x-message-ttl": config.queueTtlMs,
    "x-max-length": config.queueMaxLength,
  };
}

/** Publishes one canonical event to one durable participant mailbox. */
export function publishChannelMessage(channel: AmqpChannel, message: ChannelMessage, recipient: string, satisfaction?: ChannelSatisfaction): void {
  const spec = toChannelMessagePublish(message, recipient, satisfaction);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
}

/** Routes an independent task status event without coupling it to channels. */
export function publishTaskStatus(channel: AmqpChannel, event: TaskStatusEvent): void {
  const spec = toTaskStatusPublish(event);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
}

function agentOrigin(agent: RegisteredAgent): A2AOrigin {
  return {
    instance_id: agent.agent_id,
    name: agent.name,
    host: agent.host,
    ...(agent.project === undefined ? {} : { project: agent.project }),
  };
}

function channelStore(services: CoreServices): ChannelStore {
  if (services.channels === undefined) throw new Error("channel_store_unavailable");
  return services.channels;
}

function checkSender(services: CoreServices, senderId: string, keyId?: string): RegisteredAgent | undefined {
  const sender = services.registry.get(senderId);
  if (sender === undefined) return undefined;
  if (keyId !== undefined && sender.key_id !== keyId) throw new Error("Agent is bound to a different key");
  return sender;
}

function checkParticipants(services: CoreServices, senderId: string, recipients: readonly string[] | undefined): string | undefined {
  if (recipients === undefined) return undefined;
  for (const recipient of recipients) {
    if (recipient === senderId) continue;
    if (services.registry.get(recipient) === undefined) return recipient;
  }
  return undefined;
}

async function routeChannelResult(
  services: CoreServices,
  channel: AmqpChannel,
  result: ChannelPostResult,
): Promise<void> {
  if (!result.duplicate) {
    const deliverySatisfaction = result.message.kind === "response" ? result.satisfaction : undefined;
    for (const participant of result.channel.participants) publishChannelMessage(channel, result.message, participant, deliverySatisfaction);
  }
  await services.audit("channel_message_posted", {
    channel_id: result.message.channel_id,
    message_id: result.message.message_id,
    sequence: result.message.sequence,
    kind: result.message.kind,
    duplicate: result.duplicate,
  });
}

async function postWithOrigin(
  services: CoreServices,
  channel: AmqpChannel,
  input: ChannelPostInput,
): Promise<object> {
  const result = await channelStore(services).post(input);
  await routeChannelResult(services, channel, result);
  return {
    ok: true,
    message_id: result.message.message_id,
    channel_id: result.message.channel_id,
    sequence: result.message.sequence,
    message: result.message,
    ...(result.satisfaction === undefined ? {} : { satisfaction: result.satisfaction }),
    duplicate: result.duplicate,
  };
}

async function handleChannelPost(
  services: CoreServices,
  channel: AmqpChannel,
  request: ChannelPostRpcRequest,
  keyId?: string,
): Promise<object> {
  const sender = checkSender(services, request.sender_instance_id, keyId);
  if (sender === undefined && request.sender_instance_id !== CORE_AGENT_ID) return { ok: false, error: "unknown_sender" };
  const unknownRecipient = checkParticipants(services, request.sender_instance_id, request.to);
  if (unknownRecipient !== undefined) return { ok: false, error: "unknown_participant", participant: unknownRecipient };
  const origin = sender === undefined ? coreOrigin() : agentOrigin(sender);
  return postWithOrigin(services, channel, {
    origin,
    kind: request.kind,
    ...(request.to === undefined ? {} : { to: request.to }),
    body: request.body,
    ...(request.channel_id === undefined ? {} : { channel_id: request.channel_id }),
    ...(request.response_policy === undefined ? {} : { response_policy: request.response_policy }),
    ...(request.in_reply_to === undefined ? {} : { in_reply_to: request.in_reply_to }),
    ...(request.usage === undefined ? {} : { usage: request.usage }),
    ...(request.schema === undefined ? {} : { schema: request.schema }),
    ...(request.message_id === undefined ? {} : { message_id: request.message_id }),
    ...(request.idempotency_key === undefined ? {} : { idempotency_key: request.idempotency_key }),
  });
}

/** Used by core-owned producers such as vault job notifications and DLX advisories. */
export async function postCoreChannelMessage(
  services: CoreServices,
  channel: AmqpChannel,
  input: Omit<ChannelPostInput, "origin"> & { origin?: A2AOrigin },
): Promise<ChannelMessage> {
  const result = await channelStore(services).post({ ...input, origin: input.origin ?? coreOrigin() });
  await routeChannelResult(services, channel, result);
  return result.message;
}

type TaskRpcRequest = Extract<RpcRequest, { op: "create_task" | "update_task" | "get_task" | "task_events" }>;

async function handleTaskOp(services: CoreServices, channel: AmqpChannel, request: TaskRpcRequest): Promise<object> {
  const tasks = services.tasks;
  if (tasks === undefined) return { ok: false, error: "independent_tasks_unavailable" };
  if (request.op === "create_task") {
    const task = await tasks.createTrackedTask({ contextId: request.context_id, originInstanceId: request.origin_instance_id, assigneeInstanceId: request.assignee_instance_id, ...(request.task_id === undefined ? {} : { taskId: request.task_id }), ...(request.prior_task_id === undefined ? {} : { priorTaskId: request.prior_task_id }) });
    const submitted = await tasks.updateTask(task.task_id, "submitted", { destination: task.origin_instance_id });
    if (submitted.ok) {
      publishTaskStatus(channel, submitted.event);
      return { ok: true, task: submitted.task, event: submitted.event };
    }
    return { ok: true, task };
  }
  if (request.op === "get_task") {
    const task = tasks.getTask(request.task_id);
    return task === undefined ? { ok: false, error: "unknown_task" } : { ok: true, task };
  }
  if (request.op === "task_events") return { ok: true, events: tasks.listEvents(request.task_id) };
  const result = await tasks.updateTask(request.task_id, request.state, {
    ...(request.destination === undefined ? {} : { destination: request.destination }),
    ...(request.message_id === undefined ? {} : { messageId: request.message_id }),
    ...(request.body === undefined ? {} : { body: request.body }),
    ...(request.usage === undefined ? {} : { usage: request.usage }),
    ...(request.trace_id === undefined ? {} : { traceId: request.trace_id }),
  });
  if (!result.ok) return { ok: false, error: result.error };
  publishTaskStatus(channel, result.event);
  await services.audit("task_status_routed", {
    event_id: result.event.event_id,
    task_id: result.event.task_id,
    destination: result.event.destination,
    duplicate: result.duplicate,
  });
  return { ok: true, task: result.task, event: result.event, duplicate: result.duplicate };
}

async function handleChannelRead(services: CoreServices, request: Extract<RpcRequest, { op: "get_channel" | "channel_messages" }>): Promise<object> {
  const channels = channelStore(services);
  const channel = channels.getChannel(request.channel_id);
  if (channel === undefined) return { ok: false, error: "unknown_channel" };
  if (request.op === "get_channel") return { ok: true, channel, requests: channels.listRequests(request.channel_id) };
  return { ok: true, channel_id: request.channel_id, messages: channels.listMessages(request.channel_id, request.after_sequence ?? 0, request.limit ?? 1000) };
}

type SimpleRpcRequest = Exclude<RpcRequest, { op: "register" } | TaskRpcRequest | Extract<RpcRequest, { op: "post_channel_message" | "get_channel" | "channel_messages" }>>;

async function handleRegister(
  services: CoreServices,
  channel: AmqpChannel,
  request: Extract<RpcRequest, { op: "register" }>,
  keyId?: string,
): Promise<object> {
  if (request.protocol_version !== PROTOCOL_VERSION) {
    await services.audit("agent_register_rejected", {
      agent_id: request.card.agent_id,
      reason: "protocol_version_mismatch",
      offered: request.protocol_version,
      expected: PROTOCOL_VERSION,
    });
    return { ok: false, error: "protocol_version_mismatch", expected: PROTOCOL_VERSION };
  }
  const queue = agentQueueName(request.card.agent_id);
  await channel.assertQueue(queue, { durable: true, arguments: agentQueueArguments(services.config) });
  await channel.bindQueue(queue, EXCHANGE_AGENTS, request.card.agent_id);
  const agent = await services.registry.register(request.card, keyId);
  await services.audit("agent_register", { agent_id: agent.agent_id, host: agent.host, queue });
  return { ok: true, agent, queue, protocol_version: PROTOCOL_VERSION };
}

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
  if (request.op === "list_agents") return { ok: true, agents: services.registry.list(request.include_stale === true) };
  return { ok: false, error: "unknown_rpc_operation" };
}

export async function handleRpcRequest(
  services: CoreServices,
  channel: AmqpChannel,
  request: RpcRequest,
  keyId?: string,
): Promise<object> {
  switch (request.op) {
    case "register":
      return handleRegister(services, channel, request, keyId);
    case "post_channel_message":
      return handleChannelPost(services, channel, request, keyId);
    case "get_channel":
    case "channel_messages":
      return handleChannelRead(services, request);
    case "create_task":
    case "update_task":
    case "get_task":
    case "task_events":
      return handleTaskOp(services, channel, request);
    default:
      return handleSimpleOps(services, request);
  }
}

function parseRpcMessage(message: ConsumeMessage): ReturnType<typeof parseRpcRequest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content.toString("utf8")) as unknown;
  } catch {
    return { ok: false, error: "rpc request is not valid JSON" };
  }
  return parseRpcRequest(parsed);
}

export async function startRpcServer(services: CoreServices, channel: AmqpChannel): Promise<void> {
  await channel.consume(QUEUE_CORE_RPC, (message) => {
    if (message === null) return;
    void serveRpcMessage(services, channel, message);
  });
  log("info", "rpc.listening", { queue: QUEUE_CORE_RPC });
}

async function serveRpcMessage(services: CoreServices, channel: AmqpChannel, message: ConsumeMessage): Promise<void> {
  let response: object;
  const parsed = parseRpcMessage(message);
  if (parsed.ok) {
    try {
      response = await handleRpcRequest(services, channel, parsed.request);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log("error", "rpc.handler_failed", { message: detail });
      response = { ok: false, error: detail === "Agent is bound to a different key" ? "agent_key_mismatch" : "internal_error" };
    }
  } else {
    await services.audit("rpc_rejected", { reason: parsed.error });
    response = { ok: false, error: parsed.error };
  }
  replyToRpc(channel, message, response);
  channel.ack(message);
}

function replyToRpc(channel: AmqpChannel, message: ConsumeMessage, response: object): void {
  const replyTo = message.properties.replyTo;
  if (typeof replyTo !== "string" || replyTo === "") return;
  channel.sendToQueue(replyTo, Buffer.from(JSON.stringify(response), "utf8"), {
    correlationId: message.properties.correlationId,
    contentType: "application/json",
  });
}

// Kept for core-owned callers that only need a transport-level helper.
export { coreOrigin };
