import { createHash, randomUUID } from "node:crypto";
import type { ContentMetadata, JobErrors, JobTiming, JsonObject, PipelineJob } from "./models";
import { DataTier, JobStatus } from "./models";
import { PipelineStageError, type PipelineRequest, type PipelineRunResult, type UnifiedPipeline } from "./pipeline";

const TERMINAL_STATUSES = new Set<JobStatus>([JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]);

export type JobStorage = {
  create_pipeline_job(job: PipelineJob): Promise<unknown>;
  get_pipeline_job(jobId: string): Promise<unknown>;
  find_active_pipeline_job(resourceKey: string): Promise<unknown>;
  update_pipeline_job(jobId: string, status: JobStatus, timing: JobTiming, errors: JobErrors): Promise<unknown>;
  list_pipeline_jobs(contentId: string | undefined, status: JobStatus | undefined, limit: number, offset: number): Promise<readonly [unknown[], number]>;
  get_pipeline_job_stats(): Promise<JobStatsResponse>;
  update_content_processing_status(contentId: string, status: string, pipelineVersion?: string): Promise<void>;
  get_content?(contentId: string): Promise<ContentMetadata | undefined>;
};

export type JobOrchestratorConfig = {
  pipelineVersion: string;
  notify?: (agentId: string, body: string, requestTurn: boolean) => Promise<void>;
};

export type JobSubmission = Omit<PipelineRequest, "jobId" | "pipelineVersion"> & {
  resourceKey: string;
  notifyAgentId?: string;
};

export type ReprocessSubmission = {
  contentId: string;
  contentText: string;
  preDetected?: PipelineRequest["preDetected"];
  existingTopics?: PipelineRequest["existingTopics"];
};

export type JobStatusResponse = {
  job_id: string;
  content_id: string;
  status: JobStatus;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
};

export type JobDetailResponse = JobStatusResponse & {
  error_code?: string | null;
  error_message?: string | null;
  error_stage?: string | null;
  resource_key?: string;
  pipeline_version?: string;
  metadata?: PipelineJob["metadata"];
};

export type JobListResponse = {
  jobs: JobStatusResponse[];
  total: number;
};

export type JobStatsResponse = {
  total_jobs: number;
  completed_jobs: number;
  failed_jobs: number;
  cancelled_jobs: number;
  average_completion_seconds: number | null;
};

export type CancelResponse = {
  job_id: string;
  status: JobStatus;
  message: string;
};

function valueRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jobStatus(value: unknown): JobStatus {
  if (value === JobStatus.PENDING || value === JobStatus.PROCESSING || value === JobStatus.COMPLETED || value === JobStatus.FAILED || value === JobStatus.CANCELLED) return value;
  return JobStatus.PENDING;
}

function dateValue(value: unknown): Date | undefined {
  if (value instanceof Date) return value;
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function pipelineJob(value: unknown, fallback: PipelineJob | undefined = undefined): PipelineJob | undefined {
  const row = valueRecord(value);
  if (row === undefined) return fallback;
  const resourceKey = optionalText(row.resource_key) ?? fallback?.resource_key;
  const contentId = optionalText(row.content_id) ?? fallback?.content_id;
  if (resourceKey === undefined || contentId === undefined) return fallback;
  return {
    id: optionalText(row.id) ?? fallback?.id,
    resource_key: resourceKey,
    content_id: contentId,
    status: jobStatus(row.status ?? fallback?.status),
    pipeline_version: optionalText(row.pipeline_version) ?? fallback?.pipeline_version,
    data_tier: row.data_tier === DataTier.FULL ? DataTier.FULL : fallback?.data_tier ?? DataTier.COMPACT,
    error_code: row.error_code === null ? null : optionalText(row.error_code) ?? fallback?.error_code,
    error_message: row.error_message === null ? null : optionalText(row.error_message) ?? fallback?.error_message,
    error_stage: row.error_stage === null ? null : optionalText(row.error_stage) ?? fallback?.error_stage,
    metadata: valueRecord(row.metadata) as PipelineJob["metadata"] ?? fallback?.metadata,
    created_at: dateValue(row.created_at) ?? fallback?.created_at,
    started_at: dateValue(row.started_at) ?? fallback?.started_at,
    finished_at: dateValue(row.finished_at) ?? fallback?.finished_at,
  };
}

function resourceKey(content: ContentMetadata, contentId: string): string {
  const videoId = content.metadata?.video_id;
  if (content.content_type === "youtube" && typeof videoId === "string" && videoId !== "") return `yt:${videoId}`;
  if (content.content_type === "url") return `url:${createHash("sha256").update(contentId).digest().subarray(0, 12).toString("base64url")}`;
  return `cid:${contentId}`;
}

function timestamp(value: Date | null | undefined): string | undefined {
  return value === undefined || value === null ? undefined : value.toISOString();
}

function statusResponse(job: PipelineJob, requestedId = job.id ?? ""): JobStatusResponse {
  return {
    job_id: job.id ?? requestedId,
    content_id: job.content_id,
    status: job.status ?? JobStatus.PENDING,
    created_at: timestamp(job.created_at),
    started_at: timestamp(job.started_at),
    finished_at: timestamp(job.finished_at),
  };
}

export class PipelineOrchestrator {
  private readonly tasks = new Set<Promise<void>>();

  constructor(
    private readonly pipeline: UnifiedPipeline,
    private readonly storage: JobStorage,
    private readonly config: JobOrchestratorConfig,
  ) {}

  async submit(submission: JobSubmission): Promise<PipelineJob> {
    const active = pipelineJob(await this.storage.find_active_pipeline_job(submission.resourceKey));
    if (active !== undefined) return active;
    const pending: PipelineJob = {
      id: randomUUID().replaceAll("-", ""),
      resource_key: submission.resourceKey,
      content_id: submission.contentId,
      status: JobStatus.PENDING,
      pipeline_version: this.config.pipelineVersion,
      data_tier: DataTier.COMPACT,
      metadata: submission.notifyAgentId === undefined ? {} : { notify_agent_id: submission.notifyAgentId },
      created_at: new Date(),
    };
    const job = pipelineJob(await this.storage.create_pipeline_job(pending), pending) ?? pending;
    await this.storage.update_content_processing_status(job.content_id, JobStatus.PENDING, this.config.pipelineVersion);
    this.startWorker(job, submission);
    return job;
  }

  async reprocess(submission: ReprocessSubmission): Promise<PipelineJob | undefined> {
    if (this.storage.get_content === undefined) throw new Error("content lookup is not configured");
    const content = await this.storage.get_content(submission.contentId);
    if (content === undefined) return undefined;
    return this.submit({
      contentId: submission.contentId,
      contentText: submission.contentText,
      contentType: content.content_type,
      title: content.title ?? "Untitled",
      resourceKey: resourceKey(content, submission.contentId),
      preDetected: submission.preDetected,
      existingTopics: submission.existingTopics,
    });
  }

  async get(jobId: string): Promise<JobDetailResponse | undefined> {
    const job = pipelineJob(await this.storage.get_pipeline_job(jobId));
    if (job === undefined) return undefined;
    return {
      ...statusResponse(job, jobId),
      error_code: job.error_code,
      error_message: job.error_message,
      error_stage: job.error_stage,
      resource_key: job.resource_key,
      pipeline_version: job.pipeline_version,
      metadata: job.metadata,
    };
  }

  async list(contentId: string | undefined = undefined, status: JobStatus | undefined = undefined, limit = 50, offset = 0): Promise<JobListResponse> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) throw new Error("invalid job pagination");
    const [rows, total] = await this.storage.list_pipeline_jobs(contentId, status, limit, offset);
    return { jobs: rows.flatMap((row) => {
      const job = pipelineJob(row);
      return job === undefined ? [] : [statusResponse(job)];
    }), total };
  }

  async stats(): Promise<JobStatsResponse> {
    return this.storage.get_pipeline_job_stats();
  }

  async cancel(jobId: string): Promise<CancelResponse | undefined> {
    const job = pipelineJob(await this.storage.get_pipeline_job(jobId));
    if (job === undefined) return undefined;
    const resolvedId = job.id ?? jobId;
    const status = job.status ?? JobStatus.PENDING;
    if (TERMINAL_STATUSES.has(status)) {
      return { job_id: resolvedId, status, message: `Job already in terminal state: ${status}` };
    }
    const cancelled = pipelineJob(await this.storage.update_pipeline_job(resolvedId, JobStatus.CANCELLED, [undefined, new Date()], [undefined, undefined, undefined]), job) ?? job;
    await this.notifyTerminal(cancelled, JobStatus.CANCELLED);
    return { job_id: resolvedId, status: JobStatus.CANCELLED, message: "Job cancelled" };
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.tasks]);
  }

  private startWorker(job: PipelineJob, submission: JobSubmission): void {
    const task = this.runWorker(job, submission).catch(() => undefined).then(() => undefined);
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task));
  }

  private async runWorker(job: PipelineJob, submission: JobSubmission): Promise<void> {
    const jobId = job.id ?? "";
    try {
      const output = await this.pipeline.execute({
        contentId: job.content_id,
        contentText: submission.contentText,
        contentType: submission.contentType,
        title: submission.title,
        jobId,
        preDetected: submission.preDetected,
        existingTopics: submission.existingTopics,
        pipelineVersion: this.config.pipelineVersion,
      }, async () => {
        const current = pipelineJob(await this.storage.get_pipeline_job(jobId));
        if (current?.status === JobStatus.CANCELLED) return false;
        await this.storage.update_pipeline_job(jobId, JobStatus.PROCESSING, [new Date(), undefined], [undefined, undefined, undefined]);
        await this.storage.update_content_processing_status(job.content_id, JobStatus.PROCESSING);
        return true;
      });
      if (output === undefined) {
        const current = pipelineJob(await this.storage.get_pipeline_job(jobId));
        if (current?.status === JobStatus.CANCELLED) return;
        await this.storage.update_pipeline_job(jobId, JobStatus.FAILED, [undefined, new Date()], ["PIPELINE_DISABLED", "Unified pipeline is disabled", "pipeline"]);
        await this.storage.update_content_processing_status(job.content_id, JobStatus.FAILED);
        await this.notifyTerminal(pipelineJob(await this.storage.get_pipeline_job(jobId), job) ?? job, JobStatus.FAILED);
        return;
      }
      const current = pipelineJob(await this.storage.get_pipeline_job(jobId));
      if (current?.status === JobStatus.CANCELLED) return;
      const completed = await this.storage.update_pipeline_job(jobId, JobStatus.COMPLETED, [undefined, new Date()], [undefined, undefined, undefined]);
      const completedJob = pipelineJob(completed, job) ?? job;
      await this.pipeline.deliverCallback(completedJob, output.resultJson);
      await this.notifyTerminal(completedJob, JobStatus.COMPLETED, output.resultJson);
    } catch (error: unknown) {
      const current = pipelineJob(await this.storage.get_pipeline_job(jobId));
      if (current?.status === JobStatus.CANCELLED) return;
      const failure = this.failure(error);
      const failed = pipelineJob(await this.storage.update_pipeline_job(jobId, JobStatus.FAILED, [undefined, new Date()], [failure.code, failure.message, failure.stage]), job) ?? job;
      await this.storage.update_content_processing_status(job.content_id, JobStatus.FAILED);
      await this.notifyTerminal(failed, JobStatus.FAILED);
    }
  }

  private async notifyTerminal(job: PipelineJob, status: JobStatus, result?: JsonObject): Promise<void> {
    const agentId = job.metadata?.notify_agent_id;
    if (typeof agentId !== "string" || agentId === "" || this.config.notify === undefined) return;
    const startedAt = timestamp(job.started_at);
    const finishedAt = timestamp(job.finished_at);
    const durationSeconds = job.started_at != null && job.finished_at != null
      ? Math.max(0, (job.finished_at.getTime() - job.started_at.getTime()) / 1000)
      : null;
    const summary = typeof result?.summary === "string" ? result.summary : undefined;
    const event = {
      event: "job_terminal", job_id: job.id, content_id: job.content_id, status,
      started_at: startedAt, finished_at: finishedAt, duration_seconds: durationSeconds,
      ...(summary === undefined ? {} : { summary }),
    };
    const body = status === JobStatus.COMPLETED
      ? `YouTube ingestion completed.\n\nSummary:\n${summary ?? "No summary was generated."}\n\nJob data:\n${JSON.stringify(event)}\n\nInspect the current repository and provide a basic, concrete recommendation for how the video's ideas might apply here. Cite relevant repository paths. If it does not apply, say so. Do not modify files.`
      : JSON.stringify(event);
    try {
      await this.config.notify(agentId, body, status === JobStatus.COMPLETED);
    } catch {
      // Terminal job state is authoritative even when notification delivery is unavailable.
    }
  }

  private failure(error: unknown): { code: string; message: string; stage: string } {
    if (error instanceof PipelineStageError) return { code: error.code, message: error.message.replace(/^\[[^\]]+\] [^:]+: /, "").slice(0, 500), stage: error.stage };
    return { code: "PIPELINE_EXCEPTION", message: (error instanceof Error ? error.message : String(error)).slice(0, 500), stage: "unknown" };
  }
}

export function toJobStatusResponse(job: PipelineJob, requestedId?: string): JobStatusResponse {
  return statusResponse(job, requestedId);
}
