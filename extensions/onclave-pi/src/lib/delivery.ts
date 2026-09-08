import { isTerminalTaskState, type Message, type TaskStatusEvent } from "@onclave/envelope";
import type { AdapterAuditEventName, AdapterAuditMetadata } from "./audit";
import type { CorrelationStore } from "./correlation";
import type { SeenIds } from "./dedup";

export type DeliveryDecision = "ack" | "reject";
export type Delivered = { kind: "message"; message: Message } | { kind: "task-status"; status: TaskStatusEvent };

export type DeliveryDeps = {
  seen: SeenIds;
  correlation: CorrelationStore;
  createTask?: (message: Message) => Promise<Message>;
  markWorking?: (message: Message) => Promise<void>;
  deliverTurn: (message: Message) => void;
  deliverInert: (message: Message) => void;
  deliverStatus: (event: TaskStatusEvent, correlated: boolean) => void;
  registerInbound: (message: Message) => void;
  audit: (event: AdapterAuditEventName, metadata?: AdapterAuditMetadata) => Promise<void>;
};

export async function handleInbound(
  deps: DeliveryDeps,
  delivered: Delivered
): Promise<DeliveryDecision> {
  if (delivered.kind === "task-status") {
    if (!deps.seen.add(delivered.status.event_id)) return "ack";
    const correlated = deps.correlation.acceptStatus(delivered.status);
    deps.deliverStatus(delivered.status, correlated);
    await deps.audit("task_status_delivered", { event_id: delivered.status.event_id, correlated, state: delivered.status.state });
    return "ack";
  }
  const message = delivered.message;
  if (!deps.seen.add(message.message_id)) {
    await deps.audit("message_deduplicated", { message_id: message.message_id });
    return "ack";
  }
  if (message.type === "inform") {
    // A direct response is still an inert inform at the receiver: correlate it
    // for the waiting sender without allowing it to trigger a turn.
    deps.correlation.acceptReply(message);
    deps.deliverInert(message);
    await deps.audit("message_delivered_inert", { message_id: message.message_id, from_instance_id: message.origin.instance_id });
    return "ack";
  }
  const tracked = deps.createTask === undefined ? message : await deps.createTask(message);
  deps.registerInbound(tracked);
  if (deps.markWorking !== undefined) await deps.markWorking(tracked);
  deps.deliverTurn(tracked);
  await deps.audit("message_delivered_turn", { message_id: message.message_id, type: message.type, context_id: message.context_id });
  return "ack";
}

export function shouldTriggerStatusTurn(event: TaskStatusEvent): boolean {
  return event.state === "input-required" || isTerminalTaskState(event.state);
}
