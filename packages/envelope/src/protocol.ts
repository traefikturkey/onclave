import { isUlid } from "./ulid";
import {
  CHANNEL_PROTOCOL_VERSION,
  isChannelMessageKind,
  isResponsePolicy,
  isTaskState,
  type A2AUsage,
  type ChannelMessageKind,
  type ResponsePolicy,
  type TaskState,
} from "./a2a";

/** Core and adapters must move to the channel protocol together. */
export const PROTOCOL_VERSION = CHANNEL_PROTOCOL_VERSION;

export type AgentCard = {
  agent_id: string;
  name: string;
  host: string;
  project?: string;
  model?: string;
  capabilities?: string[];
  transport: "amqp" | "https";
};

export type HeartbeatTelemetry = {
  context_tokens?: number;
  queue_depth?: number;
};

export type ChannelPostRpcRequest = {
  op: "post_channel_message";
  sender_instance_id: string;
  kind: ChannelMessageKind;
  to?: string[];
  body: string;
  channel_id?: string;
  response_policy?: ResponsePolicy;
  in_reply_to?: string;
  usage?: A2AUsage;
  schema?: string;
  message_id?: string;
  idempotency_key?: string;
};

export type ChannelReadRpcRequest =
  | { op: "get_channel"; channel_id: string }
  | { op: "channel_messages"; channel_id: string; after_sequence?: number; limit?: number };

export type RpcRequest =
  | { op: "register"; protocol_version: number; card: AgentCard }
  | { op: "heartbeat"; agent_id: string; telemetry?: HeartbeatTelemetry }
  | { op: "unregister"; agent_id: string }
  | { op: "list_agents"; include_stale?: boolean }
  | ChannelPostRpcRequest
  | ChannelReadRpcRequest
  // The task API is deliberately independent from ChannelMessage.
  | { op: "create_task"; context_id: string; origin_instance_id: string; assignee_instance_id: string; task_id?: string; prior_task_id?: string }
  | { op: "update_task"; task_id: string; state: TaskState; destination?: string; message_id?: string; body?: string; usage?: A2AUsage; trace_id?: string }
  | { op: "get_task"; task_id: string }
  | { op: "task_events"; task_id: string };

export type RpcParseResult =
  | { ok: true; request: RpcRequest }
  | { ok: false; error: string };

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function hasValidUsage(value: unknown): value is A2AUsage {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.input_tokens)
    && (value.input_tokens as number) >= 0
    && Number.isSafeInteger(value.output_tokens)
    && (value.output_tokens as number) >= 0;
}

function hasValidCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "string");
}

function isAgentIdentity(value: unknown): boolean {
  if (!isRecord(value) || !isNonEmptyString(value.agent_id) || !isNonEmptyString(value.name) || !isNonEmptyString(value.host)) return false;
  return value.project === undefined || typeof value.project === "string";
}

export function isAgentCard(value: unknown): value is AgentCard {
  if (!isRecord(value)) return false;
  if (value.transport !== "amqp" && value.transport !== "https") return false;
  if (value.model !== undefined && !isNonEmptyString(value.model)) return false;
  if (!hasValidCapabilities(value.capabilities)) return false;
  return isAgentIdentity(value);
}

function parseRegister(record: JsonRecord): RpcParseResult {
  if (typeof record.protocol_version !== "number") return { ok: false, error: "register requires protocol_version" };
  if (!isAgentCard(record.card)) return { ok: false, error: "register requires a valid agent card" };
  return { ok: true, request: { op: "register", protocol_version: record.protocol_version, card: record.card } };
}

function parseAgentIdOp(op: "heartbeat" | "unregister", record: JsonRecord): RpcParseResult {
  if (!isNonEmptyString(record.agent_id)) return { ok: false, error: `${op} requires agent_id` };
  if (op === "heartbeat") {
    const telemetry = isRecord(record.telemetry) ? record.telemetry as HeartbeatTelemetry : undefined;
    return { ok: true, request: { op, agent_id: record.agent_id, ...(telemetry === undefined ? {} : { telemetry }) } };
  }
  return { ok: true, request: { op, agent_id: record.agent_id } };
}

function parseStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => isNonEmptyString(entry)) && new Set(value).size === value.length;
}

export function parseChannelPostRequest(record: JsonRecord): RpcParseResult {
  if (!isNonEmptyString(record.sender_instance_id) || !isChannelMessageKind(record.kind) || typeof record.body !== "string") {
    return { ok: false, error: "post_channel_message requires sender_instance_id, kind, and body" };
  }
  if (record.body.length === 0) return { ok: false, error: "post_channel_message.body must be non-empty" };
  if (record.to !== undefined && !parseStringList(record.to)) return { ok: false, error: "post_channel_message.to must be a non-empty list of unique instance ids" };
  if (record.channel_id !== undefined && !isUlid(record.channel_id)) return { ok: false, error: "post_channel_message.channel_id must be a ULID" };
  if (record.in_reply_to !== undefined && !isUlid(record.in_reply_to)) return { ok: false, error: "post_channel_message.in_reply_to must be a ULID" };
  if (record.response_policy !== undefined && !isResponsePolicy(record.response_policy)) return { ok: false, error: "post_channel_message.response_policy must be any or all" };
  if (record.usage !== undefined && !hasValidUsage(record.usage)) return { ok: false, error: "post_channel_message.usage is invalid" };
  if (record.schema !== undefined && !isNonEmptyString(record.schema)) return { ok: false, error: "post_channel_message.schema must be a string" };
  if (record.message_id !== undefined && !isUlid(record.message_id)) return { ok: false, error: "post_channel_message.message_id must be a ULID" };
  if (record.idempotency_key !== undefined && !isNonEmptyString(record.idempotency_key)) return { ok: false, error: "post_channel_message.idempotency_key must be a string" };
  if ("task_id" in record || "context_id" in record || "timeout_ms" in record) return { ok: false, error: "channel messages do not accept task_id, context_id, or timeout_ms" };

  if (record.kind === "request" && !parseStringList(record.to)) return { ok: false, error: "request requires to as a non-empty list" };
  if (record.kind === "note" && !parseStringList(record.to)) return { ok: false, error: "note requires to as a non-empty list" };
  if (record.kind === "request" && record.in_reply_to !== undefined) return { ok: false, error: "request cannot carry in_reply_to" };
  if (record.kind === "request" && parseStringList(record.to) && record.to.length === 1 && record.response_policy === "any") return { ok: false, error: "a single-recipient request must use response_policy all" };
  if (record.kind === "note" && (record.in_reply_to !== undefined || record.response_policy !== undefined)) return { ok: false, error: "note cannot carry response correlation or policy" };
  if (record.kind === "response" && record.in_reply_to === undefined) return { ok: false, error: "response requires in_reply_to outside an active request" };
  if (record.kind === "response" && record.channel_id === undefined) return { ok: false, error: "response requires channel_id and in_reply_to outside an active request" };
  if (record.kind === "response" && record.to !== undefined) return { ok: false, error: "response destination is inferred from the request" };
  if (record.kind === "response" && record.response_policy !== undefined) return { ok: false, error: "response cannot carry response_policy" };

  return {
    ok: true,
    request: {
      op: "post_channel_message",
      sender_instance_id: record.sender_instance_id,
      kind: record.kind,
      ...(record.to === undefined ? {} : { to: record.to }),
      body: record.body,
      ...(record.channel_id === undefined ? {} : { channel_id: record.channel_id }),
      ...(record.response_policy === undefined ? {} : { response_policy: record.response_policy }),
      ...(record.in_reply_to === undefined ? {} : { in_reply_to: record.in_reply_to }),
      ...(record.usage === undefined ? {} : { usage: record.usage }),
      ...(record.schema === undefined ? {} : { schema: record.schema }),
      ...(record.message_id === undefined ? {} : { message_id: record.message_id }),
      ...(record.idempotency_key === undefined ? {} : { idempotency_key: record.idempotency_key }),
    },
  };
}

function parseChannelRead(record: JsonRecord): RpcParseResult {
  if (record.op === "get_channel") {
    if (!isUlid(record.channel_id)) return { ok: false, error: "get_channel requires channel_id" };
    return { ok: true, request: { op: "get_channel", channel_id: record.channel_id } };
  }
  if (record.op === "channel_messages") {
    if (!isUlid(record.channel_id)) return { ok: false, error: "channel_messages requires channel_id" };
    const afterSequence = record.after_sequence;
    const limit = record.limit;
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || (afterSequence as number) < 0)) return { ok: false, error: "channel_messages after_sequence must be a non-negative integer" };
    if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000)) return { ok: false, error: "channel_messages limit must be between 1 and 1000" };
    return {
      ok: true,
      request: {
        op: "channel_messages",
        channel_id: record.channel_id,
        ...(afterSequence === undefined ? {} : { after_sequence: afterSequence as number }),
        ...(limit === undefined ? {} : { limit: limit as number }),
      },
    };
  }
  return { ok: false, error: `${String(record.op)} requires a channel operation` };
}

function parseTaskOp(record: JsonRecord): RpcParseResult {
  const op = record.op;
  if (op === "create_task") {
    if (!isNonEmptyString(record.context_id) || !isNonEmptyString(record.origin_instance_id) || !isNonEmptyString(record.assignee_instance_id)) return { ok: false, error: "create_task requires context_id, origin_instance_id, and assignee_instance_id" };
    if (record.task_id !== undefined && !isNonEmptyString(record.task_id)) return { ok: false, error: "create_task task_id must be a string" };
    if (record.prior_task_id !== undefined && !isNonEmptyString(record.prior_task_id)) return { ok: false, error: "create_task prior_task_id must be a string" };
    return { ok: true, request: { op, context_id: record.context_id, origin_instance_id: record.origin_instance_id, assignee_instance_id: record.assignee_instance_id, ...(record.task_id === undefined ? {} : { task_id: record.task_id }), ...(record.prior_task_id === undefined ? {} : { prior_task_id: record.prior_task_id }) } };
  }
  if (op === "update_task") {
    if (!isNonEmptyString(record.task_id) || !isTaskState(record.state)) return { ok: false, error: "update_task requires task_id and valid state" };
    if (record.destination !== undefined && !isNonEmptyString(record.destination)) return { ok: false, error: "update_task destination must be a string" };
    if (record.message_id !== undefined && !isNonEmptyString(record.message_id)) return { ok: false, error: "update_task message_id must be a string" };
    if (record.body !== undefined && typeof record.body !== "string") return { ok: false, error: "update_task body must be a string" };
    if (record.usage !== undefined && !hasValidUsage(record.usage)) return { ok: false, error: "update_task usage is invalid" };
    if (record.trace_id !== undefined && !isNonEmptyString(record.trace_id)) return { ok: false, error: "update_task trace_id must be a string" };
    return { ok: true, request: { op, task_id: record.task_id, state: record.state, ...(record.destination === undefined ? {} : { destination: record.destination }), ...(record.message_id === undefined ? {} : { message_id: record.message_id }), ...(record.body === undefined ? {} : { body: record.body }), ...(record.usage === undefined ? {} : { usage: record.usage }), ...(record.trace_id === undefined ? {} : { trace_id: record.trace_id }) } };
  }
  if ((op === "get_task" || op === "task_events") && isNonEmptyString(record.task_id)) return { ok: true, request: { op, task_id: record.task_id } };
  return { ok: false, error: `${String(op)} requires task_id` };
}

export function parseRpcRequest(value: unknown): RpcParseResult {
  if (!isRecord(value)) return { ok: false, error: "rpc request must be an object" };
  switch (value.op) {
    case "register":
      return parseRegister(value);
    case "heartbeat":
    case "unregister":
      return parseAgentIdOp(value.op, value);
    case "list_agents":
      if (value.include_stale !== undefined && typeof value.include_stale !== "boolean") return { ok: false, error: "list_agents include_stale must be a boolean" };
      return { ok: true, request: { op: "list_agents", ...(value.include_stale === true ? { include_stale: true } : {}) } };
    case "post_channel_message":
      return parseChannelPostRequest(value);
    case "get_channel":
    case "channel_messages":
      return parseChannelRead(value);
    case "create_task":
    case "update_task":
    case "get_task":
    case "task_events":
      return parseTaskOp(value);
    default:
      return { ok: false, error: `unknown rpc op: ${String(value.op)}` };
  }
}
