import type { ChannelMessage, ChannelSatisfaction, TaskStatusEvent } from "@onclave/envelope";
import type { AdapterAuditEventName, AdapterAuditMetadata } from "./audit";
import type { CorrelationStore } from "./correlation";
import type { DeliveryRecord, SeenIds } from "./dedup";

export type DeliveryDecision = "ack";
export type Delivered =
  | { kind: "message"; message: ChannelMessage; satisfaction?: ChannelSatisfaction }
  | { kind: "task-status"; status: TaskStatusEvent };

export type DeliveryDeps = {
  agentId: string;
  seen: SeenIds;
  correlation: CorrelationStore;
  deliverTurn: (message: ChannelMessage) => void;
  deliverInert: (message: ChannelMessage, satisfaction?: ChannelSatisfaction) => void;
  deliverStatus?: (event: TaskStatusEvent) => void;
  registerInbound: (message: ChannelMessage) => void;
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
      // Independent task status remains displayable, but it is not a hidden
      // channel response and never starts a peer turn.
      deps.deliverStatus?.(delivered.status);
      await auditOnce(deps, record, "task_status_delivered", {
        event_id: delivered.status.event_id,
        state: delivered.status.state,
      });
    } else {
      const respondsToThisInstance = delivered.message.kind === "request"
        && delivered.message.response_requested_from?.includes(deps.agentId) === true;
      if (respondsToThisInstance) {
        if (!record.registered) {
          deps.registerInbound(delivered.message);
          record.registered = true;
        }
        if (!record.piDelivered) {
          deps.deliverTurn(delivered.message);
          record.piDelivered = true;
        }
        await auditOnce(deps, record, "message_delivered_turn", {
          message_id: delivered.message.message_id,
          kind: delivered.message.kind,
          channel_id: delivered.message.channel_id,
          sequence: delivered.message.sequence,
        });
      } else {
        if (!record.piDelivered) {
          deps.deliverInert(delivered.message, delivered.satisfaction);
          record.piDelivered = true;
        }
        await auditOnce(deps, record, "message_delivered_inert", {
          message_id: delivered.message.message_id,
          kind: delivered.message.kind,
          channel_id: delivered.message.channel_id,
        });
      }
    }
    deps.seen.markCompleted(record);
    record.active = false;
    return "ack";
  } catch (error) {
    record.active = false;
    throw error;
  }
}

function claim(deps: DeliveryDeps, domain: "message" | "task-status", id: string): DeliveryRecord {
  const record = deps.seen.begin(domain, id);
  if (record.completed) return record;
  if (record.active) throw new DeliveryPendingError(id);
  record.active = true;
  return record;
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
    // Pi turn, so retain the completed record and surface audit loss separately.
    (deps.reportAuditFailure ?? ((failure) => console.error("Onclave delivery audit failed", failure)))(error);
  }
}
