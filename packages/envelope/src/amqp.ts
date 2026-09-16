import {
  CHANNEL_PROTOCOL_VERSION,
  parseChannelMessage,
  parseChannelSatisfaction,
  parseTaskStatusEvent,
  TASK_PROTOCOL_VERSION,
  type ChannelMessage,
  type ChannelSatisfaction,
  type TaskStatusEvent,
} from "./a2a";

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
export type ChannelAmqpPublishSpec = AmqpPublishSpec & { kind: "message" };
export type A2AAmqpPublishSpec = ChannelAmqpPublishSpec | (AmqpPublishSpec & { kind: "task-status" });
export type A2AConsumedMessage = { content: Buffer | Uint8Array; properties: AmqpConsumedProperties };
export type AmqpConsumedProperties = { messageId?: unknown; correlationId?: unknown; expiration?: unknown; headers?: JsonRecord };

export function agentQueueName(instanceId: string): string { return `${AGENT_QUEUE_PREFIX}${instanceId}`; }

export function parseExpiration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function jsonRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonList(value: unknown): string | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? JSON.stringify(value) : undefined;
}

/**
 * Builds one durable mailbox delivery. The caller chooses the recipient so
 * the core can fan out a single canonical channel event to every participant.
 */
export function toChannelMessagePublish(message: ChannelMessage, recipient?: string, satisfaction?: ChannelSatisfaction): ChannelAmqpPublishSpec {
  if (satisfaction !== undefined && message.kind !== "response") throw new Error("channel satisfaction is only valid for response messages");
  if (recipient !== undefined && !message.participants.includes(recipient)) throw new Error("channel recipient must be a participant");
  const routingKey = recipient ?? message.participants.find((participant) => participant !== message.origin.instance_id) ?? message.origin.instance_id;
  const options: AmqpPublishOptions = {
    persistent: true,
    contentType: "application/json",
    messageId: message.message_id,
    correlationId: message.channel_id,
    replyTo: agentQueueName(message.origin.instance_id),
    headers: {
      "x-onclave-channel-v": message.protocol_version,
      "x-onclave-channel-kind": "message",
      channel_id: message.channel_id,
      message_id: message.message_id,
      sequence: message.sequence,
      kind: message.kind,
      origin: JSON.stringify(message.origin),
      participants: JSON.stringify(message.participants),
      sent_at: message.sent_at,
      ...(message.response_requested_from === undefined ? {} : { response_requested_from: jsonList(message.response_requested_from) }),
      ...(message.response_policy === undefined ? {} : { response_policy: message.response_policy }),
      ...(message.in_reply_to === undefined ? {} : { in_reply_to: message.in_reply_to }),
      ...(message.schema === undefined ? {} : { schema: message.schema }),
      ...(satisfaction === undefined ? {} : { response_satisfaction: JSON.stringify(satisfaction) }),
      recipient: routingKey,
    },
  };
  return {
    kind: "message",
    routingKey,
    content: Buffer.from(JSON.stringify(message), "utf8"),
    options,
  };
}

export function channelMessagePublishSpecs(message: ChannelMessage, satisfaction?: ChannelSatisfaction): ChannelAmqpPublishSpec[] {
  return message.participants.map((participant) => toChannelMessagePublish(message, participant, satisfaction));
}

function parseContent(message: A2AConsumedMessage): unknown | undefined {
  try {
    return JSON.parse(Buffer.from(message.content).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

export function fromChannelMessage(message: A2AConsumedMessage): A2AParseResult {
  const headers = message.properties.headers ?? {};
  if (headers["x-onclave-channel-v"] !== CHANNEL_PROTOCOL_VERSION || headers["x-onclave-channel-kind"] !== "message") {
    return { ok: false, error: "protocol_version_mismatch" };
  }
  const content = parseContent(message);
  if (content === undefined) return { ok: false, error: "channel message content is not valid JSON" };
  const candidate = jsonRecord(content) && "message" in content ? content.message : content;
  const parsed = parseChannelMessage(candidate);
  if (!parsed.ok) return parsed;
  if (headers.message_id !== undefined && headers.message_id !== parsed.value.message_id) return { ok: false, error: "channel message header identity does not match content" };
  if (headers.channel_id !== undefined && headers.channel_id !== parsed.value.channel_id) return { ok: false, error: "channel message header identity does not match content" };
  if (headers.sequence !== undefined && headers.sequence !== parsed.value.sequence) return { ok: false, error: "channel message header identity does not match content" };
  if (headers.kind !== undefined && headers.kind !== parsed.value.kind) return { ok: false, error: "channel message header identity does not match content" };
  if (message.properties.messageId !== undefined && message.properties.messageId !== parsed.value.message_id) return { ok: false, error: "channel message property identity does not match content" };
  if (headers.response_satisfaction === undefined) return { ok: true, message: parsed.value };
  let satisfactionValue: unknown;
  try {
    satisfactionValue = JSON.parse(String(headers.response_satisfaction)) as unknown;
  } catch {
    return { ok: false, error: "channel satisfaction is not valid JSON" };
  }
  const satisfaction = parseChannelSatisfaction(satisfactionValue);
  if (!satisfaction.ok) return satisfaction;
  if (parsed.value.kind !== "response" || satisfaction.value.channel_id !== parsed.value.channel_id || satisfaction.value.request_message_id !== parsed.value.in_reply_to) {
    return { ok: false, error: "channel satisfaction does not match message" };
  }
  return { ok: true, message: parsed.value, satisfaction: satisfaction.value };
}

export type A2AParseResult = { ok: true; message: ChannelMessage; satisfaction?: ChannelSatisfaction } | { ok: false; error: string };
export type A2AStatusParseResult = { ok: true; event: TaskStatusEvent } | { ok: false; error: string };

export function toTaskStatusPublish(event: TaskStatusEvent): A2AAmqpPublishSpec {
  return {
    kind: "task-status",
    routingKey: event.destination,
    content: Buffer.from(JSON.stringify({ body: event.body, usage: event.usage }), "utf8"),
    options: {
      persistent: true,
      contentType: "application/json",
      messageId: event.event_id,
      correlationId: event.context_id,
      replyTo: agentQueueName(event.origin_instance_id),
      headers: {
        "x-onclave-a2a-v": event.protocol_version,
        "x-onclave-a2a-kind": "task-status",
        task_id: event.task_id,
        context_id: event.context_id,
        origin_instance_id: event.origin_instance_id,
        destination: event.destination,
        state: event.state,
        occurred_at: event.occurred_at,
        ...(event.message_id === undefined ? {} : { message_id: event.message_id }),
        ...(event.trace_id === undefined ? {} : { trace_id: event.trace_id }),
      },
    },
  };
}

export const toA2ATaskStatusPublish = toTaskStatusPublish;

export function fromA2ATaskStatus(message: A2AConsumedMessage): A2AStatusParseResult {
  const headers = message.properties.headers ?? {};
  if (headers["x-onclave-a2a-v"] !== TASK_PROTOCOL_VERSION || headers["x-onclave-a2a-kind"] !== "task-status") {
    return { ok: false, error: "protocol_version_mismatch" };
  }
  const content = parseContent(message);
  if (content === undefined) return { ok: false, error: "task status content is not valid JSON" };
  if (!jsonRecord(content)) return { ok: false, error: "task status content is not an object" };
  const parsed = parseTaskStatusEvent({
    protocol_version: headers["x-onclave-a2a-v"],
    event_id: message.properties.messageId,
    task_id: headers.task_id,
    context_id: headers.context_id,
    origin_instance_id: headers.origin_instance_id,
    destination: headers.destination,
    state: headers.state,
    occurred_at: headers.occurred_at,
    ...(headers.message_id === undefined ? {} : { message_id: headers.message_id }),
    ...(content.body === undefined ? {} : { body: content.body }),
    ...(content.usage === undefined ? {} : { usage: content.usage }),
    ...(headers.trace_id === undefined ? {} : { trace_id: headers.trace_id }),
  });
  return parsed.ok ? { ok: true, event: parsed.value } : parsed;
}
