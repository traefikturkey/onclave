import type { PipelineStage } from "./job-stages";
import type { JsonObject } from "./models";

export type JobDeliveryKind = "callback" | "notification";
export type JobDeliveryStatus = "pending" | "processing" | "delivered";

export type JobDeliveryIntent = {
  kind: JobDeliveryKind;
  target: string;
  idempotency_key: string;
  payload: JsonObject;
};

/** Outbox delivery is at-least-once; receivers must deduplicate the stable idempotency_key. */
export type JobDelivery = JobDeliveryIntent & {
  id: string;
  job_id: string;
  status: JobDeliveryStatus;
  attempt_count: number;
  next_attempt_at: Date;
  lease_token?: string | null;
  lease_expires_at?: Date | null;
  last_error_code?: string | null;
  created_at: Date;
  updated_at: Date;
  delivered_at?: Date | null;
};

export type VaultPipelineEventName =
  | "job.claimed"
  | "job.started"
  | "job.terminal"
  | "job.recovery_missing_payload"
  | "pipeline.stage.started"
  | "pipeline.stage.completed"
  | "pipeline.stage.failed"
  | "provider.request.started"
  | "provider.request.completed"
  | "provider.request.failed"
  | "delivery.attempt_started"
  | "delivery.attempt_succeeded"
  | "delivery.attempt_failed";

/** Structured observability labels only. Never add request, result, body, URL, or secret values. */
export type VaultPipelineEvent = {
  event: VaultPipelineEventName;
  occurred_at: string;
  job_id?: string;
  stage?: PipelineStage;
  provider?: string;
  model?: string;
  outcome?: "success" | "failure";
  delivery_kind?: JobDeliveryKind;
  attempt?: number;
  duration_ms?: number;
  error_code?: string;
};

export type VaultEventSink = (event: Readonly<VaultPipelineEvent>) => void;

export function emitVaultEvent(sink: VaultEventSink | undefined, event: Omit<VaultPipelineEvent, "occurred_at">): void {
  if (sink === undefined) return;
  try {
    sink({ ...event, occurred_at: new Date().toISOString() });
  } catch {
    // Telemetry must not change job or delivery outcomes.
  }
}

export function deliveryRetryDelay(attempt: number, baseMs: number, maxMs: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("delivery attempt must be a positive integer");
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempt - 1, 52));
}
