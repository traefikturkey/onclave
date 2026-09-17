import { isUlid, ulid } from "./ulid";

/**
 * Channel messages deliberately use a new wire version.  The previous
 * protocol described point-to-point task messages; it must not be accepted by
 * a channel-aware core or adapter.
 */
export const CHANNEL_PROTOCOL_VERSION = 3;
export const LEGACY_CHANNEL_PROTOCOL_VERSION = 2;
export const TASK_PROTOCOL_VERSION = 1;

export const CHANNEL_MESSAGE_KINDS = ["request", "response", "note", "notification"] as const;
export type ChannelMessageKind = (typeof CHANNEL_MESSAGE_KINDS)[number];

export const RESPONSE_POLICIES = ["any", "all"] as const;
export type ResponsePolicy = (typeof RESPONSE_POLICIES)[number];

export const CHANNEL_REQUEST_STATES = ["open", "satisfied"] as const;
export type ChannelRequestStateName = (typeof CHANNEL_REQUEST_STATES)[number];

export type A2AOrigin = {
  instance_id: string;
  name: string;
  host: string;
  project?: string;
};

export type A2AUsage = {
  input_tokens: number;
  output_tokens: number;
};

/** The only message shape carried over the Onclave channel boundary. */
export type ChannelMessage = {
  protocol_version: number;
  channel_id: string;
  message_id: string;
  sequence: number;
  kind: ChannelMessageKind;
  origin: A2AOrigin;
  participants: string[];
  body: string;
  sent_at: string;
  response_requested_from?: string[];
  response_policy?: ResponsePolicy;
  in_reply_to?: string;
  usage?: A2AUsage;
  schema?: string;
};

/** Durable state needed to evaluate whether a request is satisfied. */
export type ChannelRequestState = {
  protocol_version: number;
  channel_id: string;
  request_message_id: string;
  origin_instance_id: string;
  response_requested_from: string[];
  response_policy: ResponsePolicy;
  responders_received: string[];
  state: ChannelRequestStateName;
};

/** A logical channel aggregate. There is no model-managed close operation. */
export type Channel = {
  protocol_version: number;
  channel_id: string;
  participants: string[];
  next_sequence: number;
  created_at: string;
  updated_at: string;
  open: true;
};

export type ChannelSatisfaction = Pick<
  ChannelRequestState,
  "request_message_id" | "response_requested_from" | "response_policy" | "responders_received" | "state"
> & { channel_id: string };

/*
 * Keep task contracts available for callers that use the independent task
 * API. Tasks are not embedded in ChannelMessage and use their own historical
 * task version.
 */
export const TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export type Task = {
  protocol_version: number;
  task_id: string;
  context_id: string;
  origin_instance_id: string;
  assignee_instance_id: string;
  state: TaskState;
  created_at: string;
  updated_at: string;
  usage: A2AUsage;
  prior_task_id?: string;
};

export type TaskStatusEvent = {
  protocol_version: number;
  event_id: string;
  task_id: string;
  context_id: string;
  origin_instance_id: string;
  destination: string;
  state: TaskState;
  occurred_at: string;
  message_id?: string;
  body?: string;
  usage?: A2AUsage;
  trace_id?: string;
};

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };
export type TransitionResult =
  | { ok: true; state: TaskState }
  | { ok: false; error: "illegal_transition" | "terminal_immutable" };

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "failed", "canceled", "rejected"]);
const ALLOWED_TRANSITIONS: ReadonlyMap<TaskState, ReadonlySet<TaskState>> = new Map([
  ["submitted", new Set(["working", "input-required", "failed", "canceled", "rejected"])],
  ["working", new Set(["working", "input-required", "completed", "failed", "canceled"])],
  ["input-required", new Set(["working", "completed", "failed", "canceled"])],
  ["completed", new Set()],
  ["failed", new Set()],
  ["canceled", new Set()],
  ["rejected", new Set()],
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value: unknown): value is string {
  return nonEmpty(value) && !Number.isNaN(Date.parse(value));
}

function usage(value: unknown): value is A2AUsage {
  return record(value)
    && Number.isSafeInteger(value.input_tokens)
    && (value.input_tokens as number) >= 0
    && Number.isSafeInteger(value.output_tokens)
    && (value.output_tokens as number) >= 0;
}

function origin(value: unknown): value is A2AOrigin {
  return record(value)
    && nonEmpty(value.instance_id)
    && nonEmpty(value.name)
    && nonEmpty(value.host)
    && (value.project === undefined || typeof value.project === "string");
}

function optional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function stringList(value: unknown, allowEmpty = false): value is string[] {
  return Array.isArray(value)
    && (allowEmpty || value.length > 0)
    && value.every((entry) => nonEmpty(entry));
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export function normalizeParticipants(values: readonly string[]): string[] {
  if (!stringList(values) || !unique(values)) throw new Error("participants must be a non-empty list of unique instance ids");
  return [...values].sort((left, right) => left.localeCompare(right));
}

export function isChannelMessageKind(value: unknown): value is ChannelMessageKind {
  return typeof value === "string" && (CHANNEL_MESSAGE_KINDS as readonly string[]).includes(value);
}

export function isResponsePolicy(value: unknown): value is ResponsePolicy {
  return typeof value === "string" && (RESPONSE_POLICIES as readonly string[]).includes(value);
}

export function isChannelRequestState(value: unknown): value is ChannelRequestStateName {
  return typeof value === "string" && (CHANNEL_REQUEST_STATES as readonly string[]).includes(value);
}

function responseStateIsSatisfied(expected: readonly string[], received: readonly string[], policy: ResponsePolicy): boolean {
  return policy === "any" ? received.length > 0 : expected.every((id) => received.includes(id));
}

/** The settled default: direct requests require the named recipient; groups use any. */
export function defaultResponsePolicy(responseRequestedFrom: readonly string[]): ResponsePolicy {
  if (responseRequestedFrom.length === 0) throw new Error("request requires at least one response recipient");
  return responseRequestedFrom.length === 1 ? "all" : "any";
}

export function resolveResponseExpectation(
  responseRequestedFrom: readonly string[],
  requestedPolicy?: ResponsePolicy,
): { response_requested_from: string[]; response_policy: ResponsePolicy } {
  const responders = normalizeParticipants(responseRequestedFrom);
  if (requestedPolicy !== undefined && !isResponsePolicy(requestedPolicy)) throw new Error("response_policy must be any or all");
  const defaultPolicy = defaultResponsePolicy(responders);
  if (responders.length === 1 && requestedPolicy === "any") {
    throw new Error("a single-recipient request must use response_policy all");
  }
  return {
    response_requested_from: responders,
    response_policy: responders.length === 1 ? "all" : requestedPolicy ?? defaultPolicy,
  };
}

export function isTaskState(value: unknown): value is TaskState {
  return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value);
}

export function isTerminalTaskState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function parseChannelMessage(value: unknown): ParseResult<ChannelMessage> {
  if (!record(value)) return { ok: false, error: "channel message must be an object" };
  if (value.protocol_version !== CHANNEL_PROTOCOL_VERSION) return { ok: false, error: "protocol_version_mismatch" };
  if ("task_id" in value || "context_id" in value || "timeout_ms" in value) return { ok: false, error: "channel messages do not accept task_id, context_id, or timeout_ms" };
  if (!isUlid(value.channel_id) || !isUlid(value.message_id)) return { ok: false, error: "channel message ids must be ULIDs" };
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) return { ok: false, error: "channel message sequence is invalid" };
  if (!isChannelMessageKind(value.kind)) return { ok: false, error: "unknown channel message kind" };
  const candidateOrigin = value.origin;
  const candidateParticipants = value.participants;
  if (!origin(candidateOrigin) || !stringList(candidateParticipants) || !unique(candidateParticipants) || !candidateParticipants.includes(candidateOrigin.instance_id) || typeof value.body !== "string") {
    return { ok: false, error: "channel message origin, participants, or body is invalid" };
  }
  if (!timestamp(value.sent_at)) return { ok: false, error: "channel message timestamp is invalid" };
  if (!optional(value.usage, usage) || !optional(value.schema, nonEmpty)) return { ok: false, error: "channel message optional fields are invalid" };

  if (value.kind === "request") {
    const candidateResponders = value.response_requested_from;
    if (!stringList(candidateResponders) || !unique(candidateResponders) || candidateResponders.some((id) => !candidateParticipants.includes(id) || id === candidateOrigin.instance_id)) {
      return { ok: false, error: "request must name unique participant responders" };
    }
    if (!isResponsePolicy(value.response_policy)) return { ok: false, error: "request must include response_policy" };
    if (candidateResponders.length === 1 && value.response_policy !== "all") return { ok: false, error: "a single-recipient request must use response_policy all" };
    if (value.in_reply_to !== undefined) return { ok: false, error: "request cannot carry in_reply_to" };
  } else if (value.kind === "response") {
    if (!isUlid(value.in_reply_to)) return { ok: false, error: "response requires in_reply_to" };
    if (value.response_requested_from !== undefined || value.response_policy !== undefined) return { ok: false, error: "response cannot carry response expectation" };
  } else if (value.kind === "note" && (value.response_requested_from !== undefined || value.response_policy !== undefined || value.in_reply_to !== undefined)) {
    return { ok: false, error: "note cannot carry response expectation or in_reply_to" };
  } else if (value.kind === "notification") {
    if (!candidateParticipants.some((id) => id !== candidateOrigin.instance_id)) return { ok: false, error: "notification requires at least one recipient" };
    if (value.response_requested_from !== undefined || value.response_policy !== undefined || value.in_reply_to !== undefined) {
      return { ok: false, error: "notification cannot carry response expectation or in_reply_to" };
    }
  }
  return { ok: true, value: value as ChannelMessage };
}

export type CreateChannelMessageInput = {
  channel_id: string;
  kind: ChannelMessageKind;
  origin: A2AOrigin;
  participants: readonly string[];
  body: string;
  response_requested_from?: readonly string[];
  response_policy?: ResponsePolicy;
  in_reply_to?: string;
  usage?: A2AUsage;
  schema?: string;
  sequence?: number;
  message_id?: string;
  now?: () => Date;
};

export function createChannelMessage(input: CreateChannelMessageInput): ChannelMessage {
  if (input.kind === "request" && input.in_reply_to !== undefined) throw new Error("request cannot carry in_reply_to");
  if (input.kind === "response" && (input.response_requested_from !== undefined || input.response_policy !== undefined)) throw new Error("response cannot carry response expectation");
  if ((input.kind === "note" || input.kind === "notification") && (input.response_requested_from !== undefined || input.response_policy !== undefined || input.in_reply_to !== undefined)) throw new Error(`${input.kind} cannot carry response expectation or in_reply_to`);
  if (input.kind === "notification" && !input.participants.some((id) => id !== input.origin.instance_id)) throw new Error("notification requires at least one recipient");
  const responders = input.kind === "request"
    ? resolveResponseExpectation(input.response_requested_from ?? input.participants.filter((id) => id !== input.origin.instance_id), input.response_policy)
    : undefined;
  const message: ChannelMessage = {
    protocol_version: CHANNEL_PROTOCOL_VERSION,
    channel_id: input.channel_id,
    message_id: input.message_id ?? ulid(),
    sequence: input.sequence ?? 1,
    kind: input.kind,
    origin: input.origin,
    participants: normalizeParticipants(input.participants),
    body: input.body,
    sent_at: (input.now ?? (() => new Date()))().toISOString(),
    ...(responders === undefined ? {} : responders),
    ...(input.in_reply_to === undefined ? {} : { in_reply_to: input.in_reply_to }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.schema === undefined ? {} : { schema: input.schema }),
  };
  const parsed = parseChannelMessage(message);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

export function transitionTask(from: TaskState, to: TaskState): TransitionResult {
  if (isTerminalTaskState(from)) return { ok: false, error: "terminal_immutable" };
  if (ALLOWED_TRANSITIONS.get(from)?.has(to) === true) return { ok: true, state: to };
  return { ok: false, error: "illegal_transition" };
}

export function createTask(input: { contextId: string; originInstanceId: string; assigneeInstanceId: string; now?: () => Date; taskId?: string; priorTaskId?: string }): Task {
  const taskId = input.taskId ?? ulid();
  if (!isUlid(input.contextId) || !isUlid(taskId) || (input.priorTaskId !== undefined && !isUlid(input.priorTaskId))) throw new Error("task ids must be ULIDs");
  const now = (input.now ?? (() => new Date()))().toISOString();
  return {
    protocol_version: TASK_PROTOCOL_VERSION,
    task_id: taskId,
    context_id: input.contextId,
    origin_instance_id: input.originInstanceId,
    assignee_instance_id: input.assigneeInstanceId,
    state: "submitted",
    created_at: now,
    updated_at: now,
    usage: { input_tokens: 0, output_tokens: 0 },
    ...(input.priorTaskId === undefined ? {} : { prior_task_id: input.priorTaskId }),
  };
}

export function createTaskStatusEvent(task: Task, state: TaskState, input: { destination?: string; messageId?: string; body?: string; usage?: A2AUsage; traceId?: string; now?: () => Date } = {}): TaskStatusEvent {
  const transition = transitionTask(task.state, state);
  if (!transition.ok && !(task.state === "submitted" && state === "submitted")) throw new Error(transition.error);
  return {
    protocol_version: TASK_PROTOCOL_VERSION,
    event_id: ulid(),
    task_id: task.task_id,
    context_id: task.context_id,
    origin_instance_id: task.origin_instance_id,
    destination: input.destination ?? task.origin_instance_id,
    state,
    occurred_at: (input.now ?? (() => new Date()))().toISOString(),
    ...(input.messageId === undefined ? {} : { message_id: input.messageId }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.usage === undefined ? {} : { usage: input.usage }),
    ...(input.traceId === undefined ? {} : { trace_id: input.traceId }),
  };
}

export function parseTaskStatusEvent(value: unknown): ParseResult<TaskStatusEvent> {
  if (!record(value)) return { ok: false, error: "task status must be an object" };
  if (value.protocol_version !== TASK_PROTOCOL_VERSION) return { ok: false, error: "protocol_version_mismatch" };
  if (!isUlid(value.event_id) || !isUlid(value.task_id) || !isUlid(value.context_id) || (value.message_id !== undefined && !isUlid(value.message_id))) return { ok: false, error: "task status ids must be ULIDs" };
  if (!nonEmpty(value.origin_instance_id) || !nonEmpty(value.destination) || !isTaskState(value.state)) return { ok: false, error: "task status routing or state is invalid" };
  if (!timestamp(value.occurred_at)) return { ok: false, error: "task status timestamp is invalid" };
  if (!optional(value.body, (candidate) => typeof candidate === "string") || !optional(value.usage, usage) || !optional(value.trace_id, nonEmpty)) return { ok: false, error: "task status optional fields are invalid" };
  return { ok: true, value: value as TaskStatusEvent };
}

export function parseChannelSatisfaction(value: unknown): ParseResult<ChannelSatisfaction> {
  if (!record(value)) return { ok: false, error: "channel satisfaction must be an object" };
  if (!isUlid(value.channel_id) || !isUlid(value.request_message_id)) return { ok: false, error: "channel satisfaction ids must be ULIDs" };
  const expected = value.response_requested_from;
  const received = value.responders_received;
  if (!stringList(expected) || !unique(expected) || !stringList(received, true) || !unique(received) || !isResponsePolicy(value.response_policy) || !isChannelRequestState(value.state)) return { ok: false, error: "channel satisfaction is invalid" };
  if ((expected.length === 1 && value.response_policy !== "all") || received.some((id) => !expected.includes(id)) || responseStateIsSatisfied(expected, received, value.response_policy) !== (value.state === "satisfied")) return { ok: false, error: "channel satisfaction is inconsistent" };
  return {
    ok: true,
    value: {
      channel_id: value.channel_id,
      request_message_id: value.request_message_id,
      response_requested_from: [...expected],
      response_policy: value.response_policy,
      responders_received: [...received],
      state: value.state,
    },
  };
}

export function parseChannelRequestState(value: unknown): ParseResult<ChannelRequestState> {
  if (!record(value)) return { ok: false, error: "channel request state must be an object" };
  if (value.protocol_version !== CHANNEL_PROTOCOL_VERSION) return { ok: false, error: "protocol_version_mismatch" };
  if (!isUlid(value.channel_id) || !isUlid(value.request_message_id)) return { ok: false, error: "channel request state ids must be ULIDs" };
  const expected = value.response_requested_from;
  const received = value.responders_received;
  if (!nonEmpty(value.origin_instance_id) || !stringList(expected) || !unique(expected) || !stringList(received, true) || !unique(received) || !isResponsePolicy(value.response_policy) || !isChannelRequestState(value.state)) return { ok: false, error: "channel request state is invalid" };
  if ((expected.length === 1 && value.response_policy !== "all") || received.some((id) => !expected.includes(id)) || responseStateIsSatisfied(expected, received, value.response_policy) !== (value.state === "satisfied")) return { ok: false, error: "channel request state is inconsistent" };
  return { ok: true, value: value as ChannelRequestState };
}
