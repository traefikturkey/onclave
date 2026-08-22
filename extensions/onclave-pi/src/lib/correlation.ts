import type { Message, TaskStatusEvent } from "@onclave/envelope";

export const INBOUND_CUSTOM_TYPE = "onclave-inbound";
export const STATUS_CUSTOM_TYPE = "onclave-task-status";

type Pending = {
  message: Message;
  resolve: (value: Message | TaskStatusEvent | undefined) => void;
  timer: NodeJS.Timeout;
};

// Correlation is adapter-owned state. A run can only answer an inbound message
// whose message id was explicitly framed into that run; unmatched runs are inert.
export class CorrelationStore {
  private readonly inbound = new Map<string, Message>();
  private readonly outbound = new Map<string, Message>();
  private readonly replies = new Map<string, Message>();
  private readonly events = new Map<string, TaskStatusEvent>();
  private readonly waiters = new Map<string, Pending>();

  registerInbound(message: Message): void { this.inbound.set(message.message_id, message); }
  completeInbound(messageId: string): void { this.inbound.delete(messageId); }
  inFlightCount(): number { return this.inbound.size; }

  matchAgentRun(messages: unknown[]): Message | undefined {
    for (const item of [...messages].reverse()) {
      if (item === null || typeof item !== "object") continue;
      const record = item as { customType?: unknown; details?: { messageId?: unknown } };
      if (record.customType !== INBOUND_CUSTOM_TYPE || typeof record.details?.messageId !== "string") continue;
      const message = this.inbound.get(record.details.messageId);
      if (message !== undefined) return message;
    }
    return undefined;
  }

  registerOutbound(message: Message): void { this.outbound.set(message.message_id, message); }

  acceptReply(message: Message): boolean {
    const replyTo = message.task_id ?? message.context_id;
    const original = message.task_id === undefined ? [...this.outbound.values()].find((item) => item.context_id === message.context_id) : this.outbound.get(message.task_id);
    if (original === undefined || (message.task_id !== undefined && original.task_id !== message.task_id)) return false;
    this.replies.set(original.message_id, message);
    this.resolve(original.message_id, message);
    return true;
  }

  acceptStatus(event: TaskStatusEvent): boolean {
    const original = [...this.outbound.values()].find((message) => message.task_id === event.task_id || message.context_id === event.context_id);
    if (original === undefined) return false;
    if (this.events.has(event.event_id)) return true;
    this.events.set(event.event_id, event);
    this.resolve(original.message_id, event);
    return true;
  }

  waitFor(message: Message, timeoutMs: number): Promise<Message | TaskStatusEvent | undefined> {
    const reply = this.replies.get(message.message_id);
    if (reply !== undefined) return Promise.resolve(reply);
    const event = this.latestTerminalOrInputEvent(message);
    if (event !== undefined) return Promise.resolve(event);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.waiters.delete(message.message_id); resolve(undefined); }, timeoutMs);
      timer.unref?.();
      this.waiters.set(message.message_id, { message, resolve, timer });
    });
  }

  getReply(messageId: string): Message | undefined { return this.replies.get(messageId); }
  getEvent(eventId: string): TaskStatusEvent | undefined { return this.events.get(eventId); }
  clear(): void {
    for (const waiter of this.waiters.values()) clearTimeout(waiter.timer);
    this.inbound.clear(); this.outbound.clear(); this.replies.clear(); this.events.clear(); this.waiters.clear();
  }

  private latestTerminalOrInputEvent(message: Message): TaskStatusEvent | undefined {
    return [...this.events.values()].reverse().find((event) => event.context_id === message.context_id && ["input-required", "completed", "failed", "canceled", "rejected"].includes(event.state));
  }

  private resolve(messageId: string, value: Message | TaskStatusEvent): void {
    const waiter = this.waiters.get(messageId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer); this.waiters.delete(messageId); waiter.resolve(value);
  }
}
