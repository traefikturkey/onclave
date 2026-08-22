import type { Channel, ConsumeMessage } from "amqplib";
import {
  EXCHANGE_AGENTS,
  EXCHANGE_DLX,
  PROTOCOL_VERSION,
  QUEUE_CORE_RPC,
  agentQueueName,
  parseRpcRequest,
  toA2AMessagePublish,
  toA2ATaskStatusPublish,
  type Message,
  type RpcRequest,
} from "@onclave/envelope";
import type { AuditEventName, AuditMetadata } from "./audit";
import type { TaskStore } from "./tasks";
import type { Registry } from "./registry";
import type { CoreConfig } from "./config";
import { coreOrigin } from "./core-origin";
import { log } from "./log";

export type AuditFn = (event: AuditEventName, metadata?: AuditMetadata) => Promise<void>;

export type CoreServices = {
  config: CoreConfig;
  registry: Registry;
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

export function publishMessage(channel: Channel, message: Message): void {
  const spec = toA2AMessagePublish(message);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
}

async function handleRegister(
  services: CoreServices,
  channel: Channel,
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
  const agent = await services.registry.register(request.card, keyId);
  await services.audit("agent_register", {
    agent_id: agent.agent_id,
    host: agent.host,
    queue,
  });
  return { ok: true, agent, queue, protocol_version: PROTOCOL_VERSION };
}

type TaskRpcRequest = Extract<RpcRequest, { op: "create_task" | "update_task" | "get_task" | "task_events" }>;

async function handleTaskOp(services: CoreServices, channel: Channel, request: TaskRpcRequest): Promise<object> {
  const tasks = services.tasks;
  if (tasks === undefined) return { ok: false, error: "a2a_tasks_unavailable" };
  if (request.op === "create_task") {
    const task = await tasks.createTrackedTask({ contextId: request.context_id, originInstanceId: request.origin_instance_id, assigneeInstanceId: request.assignee_instance_id, ...(request.task_id === undefined ? {} : { taskId: request.task_id }), ...(request.prior_task_id === undefined ? {} : { priorTaskId: request.prior_task_id }) });
    const submitted = await tasks.updateTask(task.task_id, "submitted", { destination: task.origin_instance_id });
    if (submitted.ok) {
      const spec = toA2ATaskStatusPublish(submitted.event);
      channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
      return { ok: true, task: submitted.task, event: submitted.event };
    }
    return { ok: true, task };
  }
  if (request.op === "get_task") {
    const task = tasks.getTask(request.task_id);
    return task === undefined ? { ok: false, error: "unknown_task" } : { ok: true, task };
  }
  if (request.op === "task_events") return { ok: true, events: tasks.listEvents(request.task_id) };
  const result = await tasks.updateTask(request.task_id, request.state, { ...(request.destination === undefined ? {} : { destination: request.destination }), ...(request.message_id === undefined ? {} : { messageId: request.message_id }), ...(request.body === undefined ? {} : { body: request.body }), ...(request.usage === undefined ? {} : { usage: request.usage }), ...(request.trace_id === undefined ? {} : { traceId: request.trace_id }) });
  if (!result.ok) return { ok: false, error: result.error };
  // Re-publish duplicates as an outbox retry. Persistent AMQP delivery plus
  // event-idempotent consumers makes reconnect recovery safe.
  const spec = toA2ATaskStatusPublish(result.event);
  channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
  await services.audit("a2a_status_routed", {
    event_id: result.event.event_id,
    task_id: result.event.task_id,
    destination: result.event.destination,
    duplicate: result.duplicate,
  });
  return { ok: true, task: result.task, event: result.event, duplicate: result.duplicate };
}

type SimpleRpcRequest = Exclude<RpcRequest, { op: "register" } | TaskRpcRequest>;

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
    return { ok: true, agents: services.registry.list(request.include_stale === true) };
  }
  return { ok: false, error: "unknown_rpc_operation" };
}

export async function handleRpcRequest(
  services: CoreServices,
  channel: Channel,
  request: RpcRequest,
  keyId?: string,
): Promise<object> {
  switch (request.op) {
    case "register":
      return handleRegister(services, channel, request, keyId);
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
