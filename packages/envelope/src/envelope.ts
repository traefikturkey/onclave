import {
  parseDelegationGrant,
  type DelegationGrant,
} from "./delegation";
import { isPerformative, type Performative } from "./performative";
import { isUlid, ulid } from "./ulid";

export const ENVELOPE_VERSION = 1;
export const DEFAULT_MAX_HOPS = 8;

export type AgentOrigin = {
  agent_id: string;
  name: string;
  host: string;
  project?: string;
};

export type TokenUsage = {
  input_tokens: number;
  output_tokens: number;
};

export type Envelope = {
  v: number;
  id: string;
  conversation_id: string;
  performative: Performative;
  from: AgentOrigin;
  to: string;
  hops: number;
  body: string;
  sent_at: string;
  in_reply_to?: string;
  ttl_ms?: number;
  traceparent?: string;
  schema?: string;
  usage?: TokenUsage;
  delegation?: DelegationGrant;
};

export type EnvelopeParseResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: string };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isOptional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function isNonNegativeNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isAgentOrigin(value: unknown): value is AgentOrigin {
  if (!isRecord(value)) return false;
  const requiredOk = ["agent_id", "name", "host"].every((key) => isNonEmptyString(value[key]));
  return requiredOk && isOptional(value.project, (project) => typeof project === "string");
}

function isTokenUsage(value: unknown): value is TokenUsage {
  if (!isRecord(value)) return false;
  return isNonNegativeNumber(value.input_tokens) && isNonNegativeNumber(value.output_tokens);
}

function isIsoTimestamp(value: unknown): boolean {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) > 0;
}

type FieldCheck = {
  field: string;
  ok: (value: unknown) => boolean;
  error: string;
};

const ENVELOPE_CHECKS: FieldCheck[] = [
  { field: "v", ok: (value) => value === ENVELOPE_VERSION, error: "unsupported envelope version" },
  { field: "id", ok: isUlid, error: "envelope id must be a ULID" },
  { field: "conversation_id", ok: isUlid, error: "conversation_id must be a ULID" },
  { field: "performative", ok: isPerformative, error: "unknown performative" },
  { field: "from", ok: isAgentOrigin, error: "from must be an agent origin card" },
  { field: "to", ok: isNonEmptyString, error: "to must be a non-empty agent id" },
  {
    field: "hops",
    ok: (value) => Number.isInteger(value) && (value as number) >= 0,
    error: "hops must be a non-negative integer",
  },
  { field: "body", ok: (value) => typeof value === "string", error: "body must be a string" },
  { field: "sent_at", ok: isIsoTimestamp, error: "sent_at must be an ISO timestamp" },
  {
    field: "in_reply_to",
    ok: (value) => isOptional(value, isUlid),
    error: "in_reply_to must be a ULID when present",
  },
  {
    field: "ttl_ms",
    ok: (value) => isOptional(value, isPositiveInteger),
    error: "ttl_ms must be a positive integer when present",
  },
  {
    field: "traceparent",
    ok: (value) => isOptional(value, isNonEmptyString),
    error: "traceparent must be a non-empty string when present",
  },
  {
    field: "schema",
    ok: (value) => isOptional(value, isNonEmptyString),
    error: "schema must be a non-empty string when present",
  },
  {
    field: "usage",
    ok: (value) => isOptional(value, isTokenUsage),
    error: "usage must contain non-negative token counts",
  },
  {
    field: "delegation",
    ok: (value) => value === undefined || parseDelegationGrant(value).ok,
    error: "delegation must be a valid delegation grant",
  },
];

const OPTIONAL_FIELDS = [
  "in_reply_to",
  "ttl_ms",
  "traceparent",
  "schema",
  "usage",
  "delegation",
] as const;

export function parseEnvelope(value: unknown): EnvelopeParseResult {
  if (!isRecord(value)) {
    return { ok: false, error: "envelope must be an object" };
  }
  for (const check of ENVELOPE_CHECKS) {
    if (!check.ok(value[check.field])) {
      return { ok: false, error: check.error };
    }
  }
  const envelope = {
    v: ENVELOPE_VERSION,
    id: value.id,
    conversation_id: value.conversation_id,
    performative: value.performative,
    from: value.from,
    to: value.to,
    hops: value.hops,
    body: value.body,
    sent_at: value.sent_at,
  } as Envelope;
  for (const field of OPTIONAL_FIELDS) {
    if (value[field] !== undefined) {
      (envelope as Record<string, unknown>)[field] = value[field];
    }
  }
  return { ok: true, envelope };
}

export type CreateEnvelopeInput = {
  performative: Performative;
  from: AgentOrigin;
  to: string;
  body: string;
  conversationId?: string;
  inReplyTo?: string;
  ttlMs?: number;
  traceparent?: string;
  schema?: string;
  usage?: TokenUsage;
  delegation?: DelegationGrant;
  now?: () => Date;
};

export function createEnvelope(input: CreateEnvelopeInput): Envelope {
  const now = input.now ?? (() => new Date());
  const conversationId = input.conversationId ?? ulid();
  return {
    v: ENVELOPE_VERSION,
    id: ulid(),
    conversation_id: conversationId,
    performative: input.performative,
    from: input.from,
    to: input.to,
    hops: 0,
    body: input.body,
    sent_at: now().toISOString(),
    ...optionalEnvelopeFields(input),
  };
}

function optionalEnvelopeFields(input: CreateEnvelopeInput): Partial<Envelope> {
  const fields: Partial<Envelope> = {};
  if (input.inReplyTo !== undefined) fields.in_reply_to = input.inReplyTo;
  if (input.ttlMs !== undefined) fields.ttl_ms = input.ttlMs;
  if (input.traceparent !== undefined) fields.traceparent = input.traceparent;
  if (input.schema !== undefined) fields.schema = input.schema;
  if (input.usage !== undefined) fields.usage = input.usage;
  if (input.delegation !== undefined) fields.delegation = input.delegation;
  return fields;
}

export type HopResult =
  | { ok: true; envelope: Envelope }
  | { ok: false; error: "hop_limit_exceeded" };

export function incrementHops(envelope: Envelope, maxHops: number = DEFAULT_MAX_HOPS): HopResult {
  const hops = envelope.hops + 1;
  if (hops > maxHops) {
    return { ok: false, error: "hop_limit_exceeded" };
  }
  return { ok: true, envelope: { ...envelope, hops } };
}

export type ReplyInput = {
  original: Envelope;
  from: AgentOrigin;
  body: string;
  usage?: TokenUsage;
  traceparent?: string;
  now?: () => Date;
};

function buildReply(performative: Performative, input: ReplyInput): Envelope {
  return createEnvelope({
    performative,
    from: input.from,
    to: input.original.from.agent_id,
    body: input.body,
    conversationId: input.original.conversation_id,
    inReplyTo: input.original.id,
    ...(input.usage !== undefined ? { usage: input.usage } : {}),
    ...(input.traceparent !== undefined ? { traceparent: input.traceparent } : {}),
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

export function buildInformReply(input: ReplyInput): Envelope {
  return buildReply("inform", input);
}

export function buildFailureReply(input: ReplyInput): Envelope {
  return buildReply("failure", input);
}

export function buildNotUnderstoodReply(input: ReplyInput): Envelope {
  return buildReply("not_understood", input);
}
