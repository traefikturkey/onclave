import { A2A_PROTOCOL_VERSION, parseMessage, parseTaskStatusEvent, type Message, type TaskStatusEvent } from "./a2a";

type JsonRecord = Record<string, unknown>;
export const AGENT_QUEUE_PREFIX = "agent.";

export type AmqpPublishOptions = {
  persistent: true;
  contentType: "application/json";
  messageId: string;
  correlationId: string;
  replyTo: string;
  expiration?: string;
  headers: JsonRecord;
};
export type AmqpPublishSpec = { routingKey: string; content: Buffer; options: AmqpPublishOptions };
export type A2AAmqpPublishSpec = AmqpPublishSpec & { kind: "message" | "task-status" };
export type A2AConsumedMessage = { content: Buffer | Uint8Array; properties: AmqpConsumedProperties };
export type AmqpConsumedProperties = { messageId?: unknown; correlationId?: unknown; expiration?: unknown; headers?: JsonRecord };

export function agentQueueName(instanceId: string): string { return `${AGENT_QUEUE_PREFIX}${instanceId}`; }
export function parseExpiration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
function jsonRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function parseJson(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  try { const parsed: unknown = JSON.parse(value); return jsonRecord(parsed) ? parsed : undefined; } catch { return undefined; }
}

export function toA2AMessagePublish(message: Message): A2AAmqpPublishSpec {
  const options: AmqpPublishOptions = {
    persistent: true, contentType: "application/json", messageId: message.message_id,
    correlationId: message.context_id, replyTo: agentQueueName(message.origin.instance_id),
    headers: { "x-onclave-a2a-v": message.protocol_version, "x-onclave-a2a-kind": "message", type: message.type, context_id: message.context_id, origin: JSON.stringify(message.origin), destination: message.destination, sent_at: message.sent_at, hops: message.hops, ...(message.task_id === undefined ? {} : { task_id: message.task_id }), ...(message.trace_id === undefined ? {} : { trace_id: message.trace_id }) },
  };
  if (message.ttl_ms !== undefined) options.expiration = String(message.ttl_ms);
  return { kind: "message", routingKey: message.destination, content: Buffer.from(JSON.stringify({ body: message.body, schema: message.schema, usage: message.usage }), "utf8"), options };
}

export function toA2ATaskStatusPublish(event: TaskStatusEvent): A2AAmqpPublishSpec {
  return { kind: "task-status", routingKey: event.destination, content: Buffer.from(JSON.stringify({ body: event.body, usage: event.usage }), "utf8"), options: { persistent: true, contentType: "application/json", messageId: event.event_id, correlationId: event.context_id, replyTo: agentQueueName(event.origin_instance_id), headers: { "x-onclave-a2a-v": event.protocol_version, "x-onclave-a2a-kind": "task-status", task_id: event.task_id, context_id: event.context_id, origin_instance_id: event.origin_instance_id, destination: event.destination, state: event.state, occurred_at: event.occurred_at, ...(event.message_id === undefined ? {} : { message_id: event.message_id }), ...(event.trace_id === undefined ? {} : { trace_id: event.trace_id }) } } };
}

export type A2AParseResult = { ok: true; message: Message } | { ok: false; error: string };
export type A2AStatusParseResult = { ok: true; event: TaskStatusEvent } | { ok: false; error: string };
export function fromA2AMessage(message: A2AConsumedMessage): A2AParseResult {
  const headers = message.properties.headers ?? {};
  if (headers["x-onclave-a2a-v"] !== A2A_PROTOCOL_VERSION || headers["x-onclave-a2a-kind"] !== "message") return { ok: false, error: "protocol_version_mismatch" };
  let content: unknown;
  try { content = JSON.parse(Buffer.from(message.content).toString("utf8")); } catch { return { ok: false, error: "message content is not valid JSON" }; }
  if (!jsonRecord(content)) return { ok: false, error: "message content is not an object" };
  const candidate = { protocol_version: headers["x-onclave-a2a-v"], message_id: message.properties.messageId, context_id: headers.context_id ?? message.properties.correlationId, task_id: headers.task_id, type: headers.type, origin: parseJson(headers.origin), destination: headers.destination, body: content.body, sent_at: headers.sent_at, hops: headers.hops, ttl_ms: parseExpiration(message.properties.expiration), schema: content.schema, usage: content.usage, trace_id: headers.trace_id };
  const parsed = parseMessage(candidate);
  return parsed.ok ? { ok: true, message: parsed.value } : parsed;
}
export function fromA2ATaskStatus(message: A2AConsumedMessage): A2AStatusParseResult {
  const headers = message.properties.headers ?? {};
  if (headers["x-onclave-a2a-v"] !== A2A_PROTOCOL_VERSION || headers["x-onclave-a2a-kind"] !== "task-status") return { ok: false, error: "protocol_version_mismatch" };
  let content: unknown;
  try { content = JSON.parse(Buffer.from(message.content).toString("utf8")); } catch { return { ok: false, error: "task status content is not valid JSON" }; }
  if (!jsonRecord(content)) return { ok: false, error: "task status content is not an object" };
  const parsed = parseTaskStatusEvent({
    protocol_version: headers["x-onclave-a2a-v"], event_id: message.properties.messageId,
    task_id: headers.task_id, context_id: headers.context_id,
    origin_instance_id: headers.origin_instance_id, destination: headers.destination,
    state: headers.state, occurred_at: headers.occurred_at,
    ...(headers.message_id === undefined ? {} : { message_id: headers.message_id }),
    ...(content.body === undefined ? {} : { body: content.body }),
    ...(content.usage === undefined ? {} : { usage: content.usage }),
    ...(headers.trace_id === undefined ? {} : { trace_id: headers.trace_id }),
  });
  return parsed.ok ? { ok: true, event: parsed.value } : parsed;
}
