import { readFile } from "node:fs/promises";
import {
  A2A_PROTOCOL_VERSION,
  createTask,
  createTaskStatusEvent,
  isTerminalTaskState,
  transitionTask,
  type A2AUsage,
  type Task,
  type TaskState,
  type TaskStatusEvent,
} from "@onclave/envelope";
import { atomicWriteJson } from "./state";

export type A2AContext = {
  context_id: string;
  origin_instance_id: string;
  participants: string[];
  created_at: string;
  updated_at: string;
};

type PersistedState = {
  protocol_version: number;
  contexts: A2AContext[];
  tasks: Task[];
  events: TaskStatusEvent[];
};

export type TaskStoreOptions = { path: string; now?: () => Date; limits?: { maxTotalTokens: number } };
export type TaskUpdateResult =
  | { ok: true; task: Task; event: TaskStatusEvent; duplicate: boolean }
  | { ok: false; error: "unknown_task" | "terminal_immutable" | "illegal_transition" | "budget_exceeded" };

export class TaskStore {
  private readonly contexts = new Map<string, A2AContext>();
  private readonly tasks = new Map<string, Task>();
  private readonly events = new Map<string, TaskStatusEvent>();
  private readonly now: () => Date;

  constructor(private readonly options: TaskStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async load(): Promise<{ contexts: number; tasks: number; events: number }> {
    let parsed: unknown;
    try { parsed = JSON.parse(await readFile(this.options.path, "utf8")); } catch { return { contexts: 0, tasks: 0, events: 0 }; }
    if (!isPersistedState(parsed)) throw new Error("invalid A2A state file");
    if (parsed.protocol_version !== A2A_PROTOCOL_VERSION) throw new Error("protocol_version_mismatch");
    for (const context of parsed.contexts) this.contexts.set(context.context_id, context);
    for (const task of parsed.tasks) this.tasks.set(task.task_id, task);
    for (const event of parsed.events) this.events.set(event.event_id, event);
    return { contexts: this.contexts.size, tasks: this.tasks.size, events: this.events.size };
  }

  private async persist(): Promise<void> {
    const state: PersistedState = { protocol_version: A2A_PROTOCOL_VERSION, contexts: [...this.contexts.values()], tasks: [...this.tasks.values()], events: [...this.events.values()] };
    await atomicWriteJson(this.options.path, state, 0o600);
  }

  createContext(contextId: string, originInstanceId: string, participants: string[] = []): A2AContext {
    const existing = this.contexts.get(contextId);
    if (existing !== undefined) return existing;
    const now = this.now().toISOString();
    const context: A2AContext = { context_id: contextId, origin_instance_id: originInstanceId, participants: [...new Set([originInstanceId, ...participants])], created_at: now, updated_at: now };
    this.contexts.set(contextId, context);
    return context;
  }

  getContext(contextId: string): A2AContext | undefined { return this.contexts.get(contextId); }
  getTask(taskId: string): Task | undefined { return this.tasks.get(taskId); }
  listEvents(taskId?: string): TaskStatusEvent[] { return [...this.events.values()].filter((event) => taskId === undefined || event.task_id === taskId); }

  async createTrackedTask(input: { contextId: string; originInstanceId: string; assigneeInstanceId: string; taskId?: string; priorTaskId?: string }): Promise<Task> {
    this.createContext(input.contextId, input.originInstanceId, [input.assigneeInstanceId]);
    const task = createTask({ ...input, now: this.now });
    const existing = this.tasks.get(task.task_id);
    if (existing !== undefined) return existing;
    this.tasks.set(task.task_id, task);
    await this.persist();
    return task;
  }

  async updateTask(taskId: string, state: TaskState, input: { destination?: string; messageId?: string; body?: string; usage?: A2AUsage; traceId?: string } = {}): Promise<TaskUpdateResult> {
    const task = this.tasks.get(taskId);
    if (task === undefined) return { ok: false, error: "unknown_task" };
    const transition = transitionTask(task.state, state);
    const initialSubmission = task.state === "submitted" && state === "submitted";
    if (!transition.ok && !initialSubmission && !(isTerminalTaskState(task.state) && state === task.state)) return { ok: false, error: transition.error };
    const existingEvent = [...this.events.values()].find((event) => event.task_id === taskId && event.state === state && (input.messageId === undefined || event.message_id === input.messageId));
    if (existingEvent !== undefined) return { ok: true, task, event: existingEvent, duplicate: true };
    const nextUsage = input.usage ?? task.usage;
    if (this.options.limits !== undefined && nextUsage.input_tokens + nextUsage.output_tokens >= this.options.limits.maxTotalTokens) {
      return { ok: false, error: "budget_exceeded" };
    }
    const event = createTaskStatusEvent(task, state, { ...input, now: this.now });
    const updated: Task = { ...task, state, updated_at: event.occurred_at, usage: nextUsage };
    this.tasks.set(taskId, updated);
    this.events.set(event.event_id, event);
    const context = this.contexts.get(task.context_id);
    if (context !== undefined) this.contexts.set(context.context_id, { ...context, updated_at: event.occurred_at });
    await this.persist();
    return { ok: true, task: updated, event, duplicate: false };
  }
}

function isPersistedState(value: unknown): value is PersistedState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.protocol_version === "number" && Array.isArray(record.contexts) && Array.isArray(record.tasks) && Array.isArray(record.events);
}
