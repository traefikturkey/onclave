import { isUlid, ulid } from "./ulid";

export const A2A_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_HOPS = 8;

export const MESSAGE_TYPES = ["ask", "request", "inform"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

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

export type Message = {
  protocol_version: number;
  message_id: string;
  context_id: string;
  task_id?: string;
  type: MessageType;
  origin: A2AOrigin;
  destination: string;
  body: string;
  sent_at: string;
  hops: number;
  ttl_ms?: number;
  usage?: A2AUsage;
  schema?: string;
  trace_id?: string;
};

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
function nonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function timestamp(value: unknown): value is string { return nonEmpty(value) && !Number.isNaN(Date.parse(value)); }
function usage(value: unknown): value is A2AUsage {
  return record(value) && Number.isSafeInteger(value.input_tokens) && (value.input_tokens as number) >= 0 && Number.isSafeInteger(value.output_tokens) && (value.output_tokens as number) >= 0;
}
function origin(value: unknown): value is A2AOrigin {
  return record(value) && nonEmpty(value.instance_id) && nonEmpty(value.name) && nonEmpty(value.host) && (value.project === undefined || typeof value.project === "string");
}
function optional(value: unknown, check: (value: unknown) => boolean): boolean { return value === undefined || check(value); }

export function isMessageType(value: unknown): value is MessageType { return typeof value === "string" && (MESSAGE_TYPES as readonly string[]).includes(value); }
export function isTaskState(value: unknown): value is TaskState { return typeof value === "string" && (TASK_STATES as readonly string[]).includes(value); }
export function isTerminalTaskState(state: TaskState): boolean { return TERMINAL_STATES.has(state); }

export function parseMessage(value: unknown): ParseResult<Message> {
  if (!record(value)) return { ok: false, error: "message must be an object" };
  if (value.protocol_version !== A2A_PROTOCOL_VERSION) return { ok: false, error: "protocol_version_mismatch" };
  if (!isUlid(value.message_id) || !isUlid(value.context_id)) return { ok: false, error: "message ids must be ULIDs" };
  if (value.task_id !== undefined && !isUlid(value.task_id)) return { ok: false, error: "task_id must be a ULID" };
  if (!isMessageType(value.type)) return { ok: false, error: "unknown message type" };
  if (!origin(value.origin) || !nonEmpty(value.destination) || typeof value.body !== "string") return { ok: false, error: "message routing or body is invalid" };
  if (!timestamp(value.sent_at) || !Number.isSafeInteger(value.hops) || (value.hops as number) < 0) return { ok: false, error: "message timestamp or hops is invalid" };
  if (!optional(value.ttl_ms, (v) => Number.isSafeInteger(v) && (v as number) > 0) || !optional(value.usage, usage) || !optional(value.schema, nonEmpty) || !optional(value.trace_id, nonEmpty)) return { ok: false, error: "message optional fields are invalid" };
  if (value.type === "inform" && value.task_id !== undefined) return { ok: false, error: "inform cannot carry a task_id" };
  return { ok: true, value: value as Message };
}

export function parseTaskStatusEvent(value: unknown): ParseResult<TaskStatusEvent> {
  if (!record(value)) return { ok: false, error: "task status must be an object" };
  if (value.protocol_version !== A2A_PROTOCOL_VERSION) return { ok: false, error: "protocol_version_mismatch" };
  if (!isUlid(value.event_id) || !isUlid(value.task_id) || !isUlid(value.context_id) || (value.message_id !== undefined && !isUlid(value.message_id))) return { ok: false, error: "task status ids must be ULIDs" };
  if (!nonEmpty(value.origin_instance_id) || !nonEmpty(value.destination) || !isTaskState(value.state)) return { ok: false, error: "task status routing or state is invalid" };
  if (!timestamp(value.occurred_at)) return { ok: false, error: "task status timestamp is invalid" };
  if (!optional(value.body, (candidate) => typeof candidate === "string") || !optional(value.usage, usage) || !optional(value.trace_id, nonEmpty)) return { ok: false, error: "task status optional fields are invalid" };
  return { ok: true, value: value as TaskStatusEvent };
}

export function createMessage(input: Omit<Message, "protocol_version" | "message_id" | "sent_at" | "hops"> & { now?: () => Date; messageId?: string }): Message {
  const now = (input.now ?? (() => new Date()))().toISOString();
  const message: Message = { protocol_version: A2A_PROTOCOL_VERSION, message_id: input.messageId ?? ulid(), context_id: input.context_id, ...(input.task_id === undefined ? {} : { task_id: input.task_id }), type: input.type, origin: input.origin, destination: input.destination, body: input.body, sent_at: now, hops: 0, ...(input.ttl_ms === undefined ? {} : { ttl_ms: input.ttl_ms }), ...(input.usage === undefined ? {} : { usage: input.usage }), ...(input.schema === undefined ? {} : { schema: input.schema }), ...(input.trace_id === undefined ? {} : { trace_id: input.trace_id }) };
  const parsed = parseMessage(message);
  if (!parsed.ok) throw new Error(parsed.error);
  return message;
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
  return { protocol_version: A2A_PROTOCOL_VERSION, task_id: taskId, context_id: input.contextId, origin_instance_id: input.originInstanceId, assignee_instance_id: input.assigneeInstanceId, state: "submitted", created_at: now, updated_at: now, usage: { input_tokens: 0, output_tokens: 0 }, ...(input.priorTaskId === undefined ? {} : { prior_task_id: input.priorTaskId }) };
}

export function createTaskStatusEvent(task: Task, state: TaskState, input: { destination?: string; messageId?: string; body?: string; usage?: A2AUsage; traceId?: string; now?: () => Date } = {}): TaskStatusEvent {
  const transition = transitionTask(task.state, state);
  if (!transition.ok && !(task.state === "submitted" && state === "submitted")) throw new Error(transition.error);
  return { protocol_version: A2A_PROTOCOL_VERSION, event_id: ulid(), task_id: task.task_id, context_id: task.context_id, origin_instance_id: task.origin_instance_id, destination: input.destination ?? task.origin_instance_id, state, occurred_at: (input.now ?? (() => new Date()))().toISOString(), ...(input.messageId === undefined ? {} : { message_id: input.messageId }), ...(input.body === undefined ? {} : { body: input.body }), ...(input.usage === undefined ? {} : { usage: input.usage }), ...(input.traceId === undefined ? {} : { trace_id: input.traceId }) };
}
