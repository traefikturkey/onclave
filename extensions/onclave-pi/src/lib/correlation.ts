import { isTerminalTaskState, type Message, type TaskStatusEvent } from "@onclave/envelope";

export const INBOUND_CUSTOM_TYPE = "onclave-inbound";
export const STATUS_CUSTOM_TYPE = "onclave-task-status";
type Outcome = Message | TaskStatusEvent;
type Pending = { resolve: (value: Outcome | undefined) => void; timer: NodeJS.Timeout; dispose: () => void };

// Session-local correlation. Context groups conversations; message IDs identify exchanges.
export class CorrelationStore {
  private readonly inbound = new Map<string, Message>();
  private readonly outbound = new Map<string, Message>();
  private readonly tasks = new Map<string, string>();
  private readonly outcomes = new Map<string, Outcome>();
  private readonly waiters = new Map<string, Pending>();
  private readonly events = new Map<string, TaskStatusEvent>();

  registerInbound(message: Message): void { this.inbound.set(message.message_id, message); }
  completeInbound(messageId: string): void { this.inbound.delete(messageId); }
  inFlightCount(): number { return this.inbound.size; }

  matchAgentRun(messages: unknown[]): Message | undefined {
    for (const item of [...messages].reverse()) {
      const record = item as { customType?: unknown; details?: { messageId?: unknown } } | null;
      if (record?.customType !== INBOUND_CUSTOM_TYPE || typeof record.details?.messageId !== "string") continue;
      const message = this.inbound.get(record.details.messageId);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  registerOutbound(message: Message): void {
    if (message.type !== "inform") this.outbound.set(message.message_id, message);
  }
  forgetOutbound(messageId: string): void { this.outbound.delete(messageId); }

  acceptReply(message: Message): boolean {
    // New adapters carry the exchange trace. Older direct replies are accepted
    // only when there is one unambiguous outstanding exchange with this peer.
    const candidates = [...this.outbound.values()].filter((original) =>
      original.destination === message.origin.instance_id && original.origin.instance_id === message.destination &&
      original.context_id === message.context_id && !this.outcomes.has(original.message_id) &&
      (message.trace_id === undefined || original.trace_id === message.trace_id));
    if (candidates.length !== 1) return false;
    this.finish(candidates[0].message_id, message);
    return true;
  }

  acceptStatus(event: TaskStatusEvent): boolean {
    const candidates = [...this.outbound.values()].filter((message) =>
      message.context_id === event.context_id && message.origin.instance_id === event.origin_instance_id &&
      message.origin.instance_id === event.destination && !this.outcomes.has(message.message_id) &&
      (event.message_id !== undefined ? message.message_id === event.message_id :
        (this.tasks.get(message.message_id) ?? message.task_id) === event.task_id));
    if (candidates.length !== 1) return false;
    const original = candidates[0];
    this.tasks.set(original.message_id, event.task_id);
    this.events.set(event.event_id, event);
    if (event.state === "input-required" || isTerminalTaskState(event.state)) this.finish(original.message_id, event);
    return true;
  }

  waitFor(message: Message, timeoutMs: number, signal?: AbortSignal): Promise<Outcome | undefined> {
    signal?.throwIfAborted();
    const outcome = this.outcomes.get(message.message_id);
    if (outcome !== undefined) return Promise.resolve(outcome);
    return new Promise((resolve, reject) => {
      const abort = () => { this.removeWaiter(message.message_id); reject(signal?.reason ?? new Error("Onclave wait canceled")); };
      const timer = setTimeout(() => { this.removeWaiter(message.message_id); resolve(undefined); }, timeoutMs);
      timer.unref?.();
      this.waiters.set(message.message_id, { resolve, timer, dispose: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  getReply(messageId: string): Message | undefined {
    const result = this.outcomes.get(messageId);
    return result && "type" in result ? result : undefined;
  }
  getEvent(eventId: string): TaskStatusEvent | undefined { return this.events.get(eventId); }
  clear(): void {
    for (const id of [...this.waiters.keys()]) {
      const waiter = this.waiters.get(id)!;
      this.removeWaiter(id);
      waiter.resolve(undefined);
    }
    this.inbound.clear(); this.outbound.clear(); this.tasks.clear(); this.outcomes.clear(); this.events.clear();
  }
  private removeWaiter(id: string): void {
    const waiter = this.waiters.get(id);
    if (!waiter) return;
    clearTimeout(waiter.timer); waiter.dispose(); this.waiters.delete(id);
  }
  private finish(id: string, value: Outcome): void {
    this.outcomes.set(id, value);
    const waiter = this.waiters.get(id);
    this.removeWaiter(id);
    waiter?.resolve(value);
  }
}
