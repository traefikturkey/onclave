import { isTerminalTaskState, type Message, type TaskStatusEvent } from "@onclave/envelope";
import type { AdapterAuditEventName, AdapterAuditMetadata } from "./audit";
import type { CorrelationStore } from "./correlation";
import type { DeliveryRecord, SeenIds } from "./dedup";

export type DeliveryDecision = "ack";
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
  reportAuditFailure?: (error: unknown) => void;
};

/** A duplicate of a currently processing delivery must keep its lease. */
export class DeliveryPendingError extends Error {
  constructor(id: string) { super(`Onclave delivery is already processing: ${id}`); }
}

export async function handleInbound(deps: DeliveryDeps, delivered: Delivered): Promise<DeliveryDecision> {
  const domain = delivered.kind === "task-status" ? "task-status" : "message";
  const id = delivered.kind === "task-status" ? delivered.status.event_id : delivered.message.message_id;
  const record = claim(deps, domain, id);
  if (record.completed) {
    if (delivered.kind === "message") await auditDuplicate(deps, delivered.message.message_id);
    return "ack";
  }
  try {
    if (delivered.kind === "task-status") {
      if (!record.correlationApplied) {
        record.correlated = deps.correlation.acceptStatus(delivered.status);
        record.correlationApplied = true;
      }
      if (!record.piDelivered) {
        deps.deliverStatus(delivered.status, record.correlated === true);
        record.piDelivered = true;
      }
      await auditOnce(deps, record, "task_status_delivered", { event_id: delivered.status.event_id, correlated: record.correlated === true, state: delivered.status.state });
    } else if (delivered.message.type === "inform") {
      if (!record.correlationApplied) {
        record.correlated = deps.correlation.acceptReply(delivered.message);
        record.correlationApplied = true;
      }
      if (!record.piDelivered) {
        deps.deliverInert(delivered.message);
        record.piDelivered = true;
      }
      await auditOnce(deps, record, "message_delivered_inert", { message_id: delivered.message.message_id, from_instance_id: delivered.message.origin.instance_id });
    } else {
      const prepared = await prepare(deps, record, delivered.message);
      if (!record.registered) {
        deps.registerInbound(prepared);
        record.registered = true;
      }
      if (!record.workingMarked) {
        if (deps.markWorking !== undefined) await deps.markWorking(prepared);
        record.workingMarked = true;
      }
      if (!record.piDelivered) {
        deps.deliverTurn(prepared);
        record.piDelivered = true;
      }
      await auditOnce(deps, record, "message_delivered_turn", { message_id: delivered.message.message_id, type: delivered.message.type, context_id: delivered.message.context_id });
    }
    deps.seen.markCompleted(record);
    record.active = false;
    return "ack";
  } catch (error) {
    record.active = false;
    throw error;
  }
}

export function shouldTriggerStatusTurn(event: TaskStatusEvent): boolean {
  return event.state === "input-required" || isTerminalTaskState(event.state);
}

function claim(deps: DeliveryDeps, domain: "message" | "task-status", id: string): DeliveryRecord {
  const record = deps.seen.begin(domain, id);
  if (record.completed) return record;
  if (record.active) throw new DeliveryPendingError(id);
  record.active = true;
  return record;
}

async function prepare(deps: DeliveryDeps, record: DeliveryRecord, message: Message): Promise<Message> {
  if (record.prepared !== undefined) return record.prepared;
  const prepared = deps.createTask === undefined ? message : await deps.createTask(message);
  record.prepared = prepared;
  return prepared;
}

async function auditDuplicate(deps: DeliveryDeps, messageId: string): Promise<void> {
  try {
    await deps.audit("message_deduplicated", { message_id: messageId });
  } catch (error) {
    (deps.reportAuditFailure ?? ((failure) => console.error("Onclave delivery audit failed", failure)))(error);
  }
}

async function auditOnce(
  deps: DeliveryDeps,
  record: DeliveryRecord,
  event: AdapterAuditEventName,
  metadata: AdapterAuditMetadata,
): Promise<void> {
  if (record.auditAttempted) return;
  record.auditAttempted = true;
  try {
    await deps.audit(event, metadata);
  } catch (error) {
    // Delivery effects are already committed. Retrying would risk a duplicate
    // turn, so retain the completed record and surface audit loss separately.
    (deps.reportAuditFailure ?? ((failure) => console.error("Onclave delivery audit failed", failure)))(error);
  }
}
