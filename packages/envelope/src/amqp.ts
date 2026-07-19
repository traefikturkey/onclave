import type { AgentOrigin, Envelope, EnvelopeParseResult } from "./envelope";
import { isAgentOrigin, parseEnvelope } from "./envelope";

export const AGENT_QUEUE_PREFIX = "agent.";

type JsonRecord = Record<string, unknown>;

export type AmqpPublishOptions = {
  persistent: true;
  contentType: "application/json";
  messageId: string;
  correlationId: string;
  replyTo: string;
  expiration?: string;
  headers: JsonRecord;
};

export type AmqpPublishSpec = {
  routingKey: string;
  content: Buffer;
  options: AmqpPublishOptions;
};

export type AmqpConsumedProperties = {
  messageId?: unknown;
  correlationId?: unknown;
  expiration?: unknown;
  headers?: JsonRecord | undefined;
};

export type AmqpConsumedMessage = {
  content: Buffer | Uint8Array;
  properties: AmqpConsumedProperties;
};

export function agentQueueName(agentId: string): string {
  return `${AGENT_QUEUE_PREFIX}${agentId}`;
}

function buildHeaders(envelope: Envelope): JsonRecord {
  const headers: JsonRecord = {
    "x-onclave-v": envelope.v,
    performative: envelope.performative,
    hops: envelope.hops,
    origin: JSON.stringify(envelope.from),
    to: envelope.to,
    sent_at: envelope.sent_at,
  };
  if (envelope.in_reply_to !== undefined) headers.in_reply_to = envelope.in_reply_to;
  if (envelope.traceparent !== undefined) headers.traceparent = envelope.traceparent;
  if (envelope.usage !== undefined) headers.usage = JSON.stringify(envelope.usage);
  return headers;
}

export function toAmqpPublish(envelope: Envelope): AmqpPublishSpec {
  const content: JsonRecord = { body: envelope.body };
  if (envelope.schema !== undefined) content.schema = envelope.schema;
  if (envelope.delegation !== undefined) content.delegation = envelope.delegation;
  const options: AmqpPublishOptions = {
    persistent: true,
    contentType: "application/json",
    messageId: envelope.id,
    correlationId: envelope.conversation_id,
    replyTo: agentQueueName(envelope.from.agent_id),
    headers: buildHeaders(envelope),
  };
  if (envelope.ttl_ms !== undefined) {
    options.expiration = String(envelope.ttl_ms);
  }
  return {
    routingKey: envelope.to,
    content: Buffer.from(JSON.stringify(content), "utf8"),
    options,
  };
}

// #lizard forgives: lizard's TS lexer merges the small helpers below into one
// region; each individual function stays well under the complexity bound.
export function parseExpiration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return undefined;
  if (parsed <= 0) return undefined;
  return parsed;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  if (value === null) return false;
  if (typeof value !== "object") return false;
  return !Array.isArray(value);
}

function parseJsonRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isJsonRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function parseOriginHeader(headers: JsonRecord): AgentOrigin | undefined {
  const origin = parseJsonRecord(headers.origin);
  return origin !== undefined && isAgentOrigin(origin) ? origin : undefined;
}

export function fromAmqpMessage(message: AmqpConsumedMessage): EnvelopeParseResult {
  const headers = message.properties.headers ?? {};
  const contentRecord = parseJsonRecord(Buffer.from(message.content).toString("utf8"));
  if (contentRecord === undefined) {
    return { ok: false, error: "message content is not a JSON object" };
  }
  const origin = parseOriginHeader(headers);
  if (origin === undefined) {
    return { ok: false, error: "origin header is not a valid agent origin card" };
  }
  const usage = headers.usage === undefined ? undefined : parseJsonRecord(headers.usage);
  if (headers.usage !== undefined && usage === undefined) {
    return { ok: false, error: "usage header is not a JSON object" };
  }
  // Optional fields left as undefined are treated as absent by parseEnvelope.
  const candidate: JsonRecord = {
    v: headers["x-onclave-v"],
    id: message.properties.messageId,
    conversation_id: message.properties.correlationId,
    performative: headers.performative,
    from: origin,
    to: headers.to,
    hops: headers.hops,
    body: contentRecord.body,
    sent_at: headers.sent_at,
    in_reply_to: headers.in_reply_to,
    ttl_ms: parseExpiration(message.properties.expiration),
    traceparent: headers.traceparent,
    schema: contentRecord.schema,
    usage,
    delegation: contentRecord.delegation,
  };
  return parseEnvelope(candidate);
}
