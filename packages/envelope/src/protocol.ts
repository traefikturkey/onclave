import { isAgentOrigin } from "./envelope";
import type { TokenUsage } from "./envelope";
import { isPerformative, type Performative } from "./performative";

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
  transport: "amqp";
};

export type HeartbeatTelemetry = {
  context_tokens?: number;
  queue_depth?: number;
};

export type RpcRequest =
  | { op: "register"; protocol_version: number; card: AgentCard }
  | { op: "heartbeat"; agent_id: string; telemetry?: HeartbeatTelemetry }
  | { op: "unregister"; agent_id: string }
  | { op: "list_agents" }
  | { op: "conversation_status"; conversation_id: string }
  | {
      op: "record_exchange";
      conversation_id: string;
      message_id: string;
      performative: Performative;
      from_agent_id: string;
      to_agent_id: string;
      usage?: TokenUsage;
    };

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

function hasValidCapabilities(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((entry) => typeof entry === "string");
}

export function isAgentCard(value: unknown): value is AgentCard {
  // #lizard forgives: TS lexer merges adjacent small helpers into one region
  if (!isRecord(value)) return false;
  const record: JsonRecord = value;
  if (record.transport !== "amqp") return false;
  if (record.model !== undefined && !isNonEmptyString(record.model)) return false;
  if (!hasValidCapabilities(record.capabilities)) return false;
  return isAgentOrigin(value);
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

function parseConversationStatus(record: JsonRecord): RpcParseResult {
  if (!isNonEmptyString(record.conversation_id)) {
    return { ok: false, error: "conversation_status requires conversation_id" };
  }
  return {
    ok: true,
    request: { op: "conversation_status", conversation_id: record.conversation_id },
  };
}

function parseRecordExchange(record: JsonRecord): RpcParseResult {
  const required = ["conversation_id", "message_id", "from_agent_id", "to_agent_id"];
  for (const field of required) {
    if (!isNonEmptyString(record[field])) {
      return { ok: false, error: `record_exchange requires ${field}` };
    }
  }
  if (!isPerformative(record.performative)) {
    return { ok: false, error: "record_exchange requires a valid performative" };
  }
  const usage = record.usage;
  if (usage !== undefined && !isRecord(usage)) {
    return { ok: false, error: "record_exchange usage must be an object" };
  }
  return {
    ok: true,
    request: {
      op: "record_exchange",
      conversation_id: record.conversation_id as string,
      message_id: record.message_id as string,
      performative: record.performative,
      from_agent_id: record.from_agent_id as string,
      to_agent_id: record.to_agent_id as string,
      ...(usage !== undefined ? { usage: usage as TokenUsage } : {}),
    },
  };
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
      return { ok: true, request: { op: "list_agents" } };
    case "conversation_status":
      return parseConversationStatus(value);
    case "record_exchange":
      return parseRecordExchange(value);
    default:
      return { ok: false, error: `unknown rpc op: ${String(value.op)}` };
  }
}
