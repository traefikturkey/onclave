import { isTaskState, type A2AUsage, type TaskState } from "./a2a";

// Versioned adapter/core handshake: the core rejects register calls whose
// protocol_version does not match so mismatches fail loudly.
export const PROTOCOL_VERSION = 1;

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

export type RpcRequest =
  | { op: "register"; protocol_version: number; card: AgentCard }
  | { op: "heartbeat"; agent_id: string; telemetry?: HeartbeatTelemetry }
  | { op: "unregister"; agent_id: string }
  | { op: "list_agents"; include_stale?: boolean }
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
  return Number.isSafeInteger(value.input_tokens) && (value.input_tokens as number) >= 0 && Number.isSafeInteger(value.output_tokens) && (value.output_tokens as number) >= 0;
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
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  if (!isRecord(value)) return false;
  const record: JsonRecord = value;
  if (record.transport !== "amqp" && record.transport !== "https") return false;
  if (record.model !== undefined && !isNonEmptyString(record.model)) return false;
  if (!hasValidCapabilities(record.capabilities)) return false;
  return isAgentIdentity(value);
}

function parseRegister(record: JsonRecord): RpcParseResult {
  if (typeof record.protocol_version !== "number") {
    return { ok: false, error: "register requires protocol_version" };
  }
  if (!isAgentCard(record.card)) {
    return { ok: false, error: "register requires a valid agent card" };
  }
  return {
    ok: true,
    request: { op: "register", protocol_version: record.protocol_version, card: record.card },
  };
}

function parseAgentIdOp(op: "heartbeat" | "unregister", record: JsonRecord): RpcParseResult {
  if (!isNonEmptyString(record.agent_id)) {
    return { ok: false, error: `${op} requires agent_id` };
  }
  if (op === "heartbeat") {
    const telemetry = isRecord(record.telemetry) ? (record.telemetry as HeartbeatTelemetry) : undefined;
    return { ok: true, request: { op, agent_id: record.agent_id, ...(telemetry ? { telemetry } : {}) } };
  }
  return { ok: true, request: { op, agent_id: record.agent_id } };
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
  if (!isRecord(value)) {
    return { ok: false, error: "rpc request must be an object" };
  }
  switch (value.op) {
    case "register":
      return parseRegister(value);
    case "heartbeat":
    case "unregister":
      return parseAgentIdOp(value.op, value);
    case "list_agents":
      if (value.include_stale !== undefined && typeof value.include_stale !== "boolean") {
        return { ok: false, error: "list_agents include_stale must be a boolean" };
      }
      return {
        ok: true,
        request: {
          op: "list_agents",
          ...(value.include_stale === true ? { include_stale: true } : {}),
        },
      };
    case "create_task":
    case "update_task":
    case "get_task":
    case "task_events":
      return parseTaskOp(value);
    default:
      return { ok: false, error: `unknown rpc op: ${String(value.op)}` };
  }
}
