import type { JsonObject } from "./models";

export const PIPELINE_STAGES = ["context_fetch", "llm_call", "parse", "chunking", "embedding", "persist"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export const PIPELINE_STAGE_STATUSES = ["pending", "processing", "completed", "failed", "skipped"] as const;
export type PipelineStageStatus = (typeof PIPELINE_STAGE_STATUSES)[number];

export type PipelineStageState = {
  status: PipelineStageStatus;
  started_at?: string | null;
  finished_at?: string | null;
  error_code?: string | null;
  error_message?: string | null;
};

export type PipelineStages = { [stage in PipelineStage]: PipelineStageState };

export function initialPipelineStages(): PipelineStages {
  return Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, { status: "pending" }])) as PipelineStages;
}

function stageStatus(value: unknown): PipelineStageStatus {
  return PIPELINE_STAGE_STATUSES.includes(value as PipelineStageStatus) ? value as PipelineStageStatus : "pending";
}

function stageState(value: unknown): PipelineStageState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { status: "pending" };
  const row = value as Record<string, unknown>;
  return {
    status: stageStatus(row.status),
    started_at: typeof row.started_at === "string" || row.started_at === null ? row.started_at : undefined,
    finished_at: typeof row.finished_at === "string" || row.finished_at === null ? row.finished_at : undefined,
    error_code: typeof row.error_code === "string" || row.error_code === null ? row.error_code : undefined,
    error_message: typeof row.error_message === "string" || row.error_message === null ? row.error_message : undefined,
  };
}

export function pipelineStages(value: unknown): PipelineStages {
  const row = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, stageState(row[stage])])) as PipelineStages;
}

export function stagesMetadata(metadata: JsonObject | undefined, stages: PipelineStages): JsonObject {
  return { ...(metadata ?? {}), stages: stages as unknown as JsonObject };
}
