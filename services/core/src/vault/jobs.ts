import { createHash, randomUUID } from "node:crypto";
import { deliveryRetryDelay, emitVaultEvent, type JobDelivery, type JobDeliveryIntent, type VaultEventSink } from "./durability";
import type { AnalysisSourceSegment } from "./analysis-budget";
import type { ContentMetadata, JobErrors, JobTiming, JsonObject, PipelineJob } from "./models";
import { normalizeStoredSummary, normalizeTranscriptFiltering, type TranscriptFilteringSummary, type WholeTranscriptResolver } from "./transcript-analysis";
import { DataTier, JobStatus } from "./models";
import { initialPipelineStages, pipelineStages, stagesMetadata, PIPELINE_STAGES, type PipelineStage, type PipelineStageStatus, type PipelineStages } from "./job-stages";
import { PipelineStageError, type PipelineRequest, type UnifiedPipeline } from "./pipeline";
import {
  JOB_TERMINAL_NOTIFICATION_SCHEMA,
  JOB_TERMINAL_NOTIFICATION_VERSION,
  type JobTerminalNotification,
  type TerminalJobStatus,
  type TerminalFilteringState,
  type TerminalSummaryCoverage,
} from "./terminal-notification-contract";
export { JOB_TERMINAL_NOTIFICATION_SCHEMA, JOB_TERMINAL_NOTIFICATION_VERSION } from "./terminal-notification-contract";

const TERMINAL_STATUSES = new Set<JobStatus>([JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]);
function isTerminalJobStatus(status: JobStatus): status is TerminalJobStatus {
  return TERMINAL_STATUSES.has(status);
}

export type JobStorage = {
  create_pipeline_job(job: PipelineJob): Promise<unknown>;
  get_pipeline_job(jobId: string): Promise<unknown>;
  find_active_pipeline_job(resourceKey: string): Promise<unknown>;
  add_pipeline_job_subscriber(jobId: string, subscriberId: string): Promise<unknown>;
  update_pipeline_job(jobId: string, status: JobStatus, timing: JobTiming, errors: JobErrors): Promise<unknown>;
  transition_pipeline_job_terminal(jobId: string, status: JobStatus, timing: JobTiming, errors: JobErrors, expectedStatuses: readonly JobStatus[], claimToken?: string, intents?: readonly JobDeliveryIntent[]): Promise<unknown>;
  transition_pipeline_job_stage?(jobId: string, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined], expectedStatuses: readonly PipelineStageStatus[], claimToken?: string): Promise<unknown>;
  claim_pipeline_job(jobId: string, claimToken: string, now: Date, leaseExpiresAt: Date): Promise<unknown>;
  renew_pipeline_job_lease(jobId: string, claimToken: string, leaseExpiresAt: Date): Promise<boolean>;
  begin_pipeline_job(jobId: string, claimToken: string, startedAt: Date): Promise<unknown>;
  list_recoverable_pipeline_jobs(now: Date, limit: number): Promise<unknown[]>;
  create_terminal_pipeline_job_delivery(jobId: string, intent: JobDeliveryIntent): Promise<unknown>;
  list_due_pipeline_job_deliveries(now: Date, limit: number): Promise<unknown[]>;
  claim_pipeline_job_delivery(deliveryId: string, leaseToken: string, now: Date, leaseExpiresAt: Date): Promise<unknown>;
  complete_pipeline_job_delivery(deliveryId: string, leaseToken: string, deliveredAt: Date): Promise<boolean>;
  retry_pipeline_job_delivery(deliveryId: string, leaseToken: string, nextAttemptAt: Date, errorCode: string): Promise<boolean>;
  list_pipeline_job_deliveries(jobId: string): Promise<JobDelivery[]>;
  list_pipeline_jobs(contentId: string | undefined, status: JobStatus | undefined, limit: number, offset: number): Promise<readonly [unknown[], number]>;
  get_pipeline_job_stats(): Promise<JobStatsResponse>;
  update_content_processing_status(contentId: string, status: string, pipelineVersion?: string): Promise<void>;
  get_content?(contentId: string): Promise<ContentMetadata | undefined>;
};

export type JobNotificationDelivery = {
  kind: "notification";
  body: string;
  schema: typeof JOB_TERMINAL_NOTIFICATION_SCHEMA;
  idempotency_key: string;
};

export type JobOrchestratorConfig = {
  pipelineVersion: string;
  notify?: (agentId: string, delivery: JobNotificationDelivery) => Promise<void>;
  /** Reprocess requests without supplied text resolve the current analysis view. */
  transcriptResolver?: WholeTranscriptResolver;
  recoveryBatchSize?: number;
  jobLeaseMs?: number;
  pollIntervalMs?: number;
  deliveryLeaseMs?: number;
  deliveryRetryBaseMs?: number;
  deliveryRetryMaxMs?: number;
  deliveryBatchSize?: number;
  onEvent?: VaultEventSink;
};

export type JobSubmission = Omit<PipelineRequest, "jobId" | "pipelineVersion"> & {
  resourceKey: string;
  notifyAgentId?: string;
};

export type ReprocessSubmission = {
  contentId: string;
  contentText?: string;
  notifyAgentId?: string;
  preDetected?: PipelineRequest["preDetected"];
  existingTopics?: PipelineRequest["existingTopics"];
  analysisSegments?: PipelineRequest["analysisSegments"];
};

export type JobStatusResponse = {
  job_id: string;
  content_id: string;
  status: JobStatus;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
  stages: PipelineStages;
};

export type JobDetailResponse = JobStatusResponse & {
  error_code?: string | null;
  error_message?: string | null;
  error_stage?: string | null;
  resource_key?: string;
  pipeline_version?: string;
  metadata?: PipelineJob["metadata"];
  stages: PipelineStages;
};

export type JobListResponse = {
  jobs: JobStatusResponse[];
  total: number;
};

export type JobDeliveryStatusResponse = Pick<JobDelivery, "id" | "job_id" | "kind" | "idempotency_key" | "status" | "attempt_count" | "next_attempt_at" | "last_error_code" | "created_at" | "updated_at" | "delivered_at">;

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

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function terminalCoverage(value: unknown): TerminalSummaryCoverage | undefined {
  const coverage = normalizeStoredSummary(value)?.summary_coverage;
  if (coverage === undefined) return undefined;
  return { status: coverage.status, generation_method: coverage.generation_method } satisfies TerminalSummaryCoverage;
}

function terminalFiltering(value: unknown): TerminalFilteringState | undefined {
  const filtering = normalizeTranscriptFiltering(value);
  if (filtering === undefined) return undefined;
  const state: TranscriptFilteringSummary = {
    outcome: filtering.outcome,
    reason: filtering.reason,
    lookup_state: filtering.lookup_state,
    timing: filtering.timing,
    retained_segment_count: filtering.retained_segment_count,
    excluded_segment_count: filtering.excluded_segment_count,
  };
  return state;
}

function notificationMetadata(content: ContentMetadata | undefined): { title?: string; coverage?: TerminalSummaryCoverage; filtering?: TerminalFilteringState } {
  const metadata = valueRecord(content?.metadata);
  const transcriptAnalysis = valueRecord(metadata?.transcript_analysis);
  const storedResult = valueRecord(metadata?.unified_result);
  const storedSummary = storedResult === undefined ? undefined : terminalCoverage(storedResult);
  const filtering = terminalFiltering(transcriptAnalysis?.filtering ?? metadata?.filtering ?? storedResult?.filtering);
  const title = nonEmptyText(content?.title);
  return {
    ...(title === undefined ? {} : { title }),
    ...(storedSummary === undefined ? {} : { coverage: storedSummary }),
    ...(filtering === undefined ? {} : { filtering }),
  };
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
    stages: pipelineStages(valueRecord(row.metadata)?.stages ?? fallback?.stages),
    request_payload: valueRecord(row.request_payload) as PipelineJob["request_payload"] ?? fallback?.request_payload,
    claim_token: row.claim_token === null ? null : optionalText(row.claim_token) ?? fallback?.claim_token,
    lease_expires_at: dateValue(row.lease_expires_at) ?? fallback?.lease_expires_at,
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
    stages: pipelineStages(job.stages),
  };
}

export class PipelineOrchestrator {
  private readonly tasks = new Set<Promise<void>>();
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTask: Promise<void> | undefined;
  private deliveryPump: Promise<void> | undefined;
  private deliveryPumpRequested = false;
  private started = false;
  private stopping = false;

  constructor(
    private readonly pipeline: UnifiedPipeline,
    private readonly storage: JobStorage,
    private readonly config: JobOrchestratorConfig,
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    await this.recoverPendingJobs();
    this.queueDeliveryPump();
    this.schedulePoll();
  }

  async stop(): Promise<void> {
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    await this.pollTask;
    if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    await this.waitForIdle();
    this.stopping = true;
    await this.waitForIdle();
    this.started = false;
  }

  async submit(submission: JobSubmission): Promise<PipelineJob> {
    const active = pipelineJob(await this.storage.find_active_pipeline_job(submission.resourceKey));
    if (active !== undefined) {
      if (submission.notifyAgentId !== undefined && active.id !== undefined) {
        const subscribed = pipelineJob(await this.storage.add_pipeline_job_subscriber(active.id, submission.notifyAgentId));
        if (subscribed !== undefined) return subscribed;
        const current = pipelineJob(await this.storage.get_pipeline_job(active.id));
        if (current !== undefined && TERMINAL_STATUSES.has(current.status ?? JobStatus.PENDING)) {
          await this.enqueueLateNotification(current, submission.notifyAgentId);
          return current;
        }
        return active;
      }
      return active;
    }
    const id = randomUUID().replaceAll("-", "");
    const request: PipelineRequest = {
      contentId: submission.contentId,
      contentText: submission.contentText,
      contentType: submission.contentType,
      title: submission.title,
      jobId: id,
      preDetected: submission.preDetected,
      existingTopics: submission.existingTopics,
      analysisSegments: submission.analysisSegments,
      pipelineVersion: this.config.pipelineVersion,
    };
    const pending: PipelineJob = {
      id,
      resource_key: submission.resourceKey,
      content_id: submission.contentId,
      status: JobStatus.PENDING,
      pipeline_version: this.config.pipelineVersion,
      data_tier: DataTier.COMPACT,
      request_payload: request as unknown as JsonObject,
      metadata: stagesMetadata({
        ...(submission.notifyAgentId === undefined ? {} : { notify_agent_ids: [submission.notifyAgentId] }),
        ...(submission.notifyAgentId === undefined || nonEmptyText(submission.title) === undefined ? {} : { notify_title: nonEmptyText(submission.title) }),
      }, initialPipelineStages()),
      stages: initialPipelineStages(),
      created_at: new Date(),
    };
    const job = pipelineJob(await this.storage.create_pipeline_job(pending), pending) ?? pending;
    await this.storage.update_content_processing_status(job.content_id, JobStatus.PENDING, this.config.pipelineVersion);
    this.scheduleClaim(job.id ?? id, request);
    return job;
  }

  async reprocess(submission: ReprocessSubmission): Promise<PipelineJob | undefined> {
    if (this.storage.get_content === undefined) throw new Error("content lookup is not configured");
    const content = await this.storage.get_content(submission.contentId);
    if (content === undefined) return undefined;
    let contentText = submission.contentText;
    let analysisSegments: readonly AnalysisSourceSegment[] | undefined = submission.analysisSegments;
    if (contentText === undefined) {
      if (this.config.transcriptResolver === undefined) throw new Error("content text or transcript resolver is required");
      const resolved = await this.config.transcriptResolver.resolve({ content_id: submission.contentId, variant: "analysis", access: "reprocess" });
      contentText = resolved.transcript.text;
      if (resolved.transcript.representation === "analysis") {
        analysisSegments = resolved.transcript.segments.map((segment) => ({
          source_segment_id: segment.source_segment_id,
          text: segment.text,
          ...(segment.start_seconds === undefined ? {} : { start_seconds: segment.start_seconds }),
          ...(segment.duration_seconds === undefined ? {} : { duration_seconds: segment.duration_seconds }),
        }));
      }
    }
    return this.submit({
      contentId: submission.contentId,
      contentText,
      contentType: content.content_type,
      title: content.title ?? "Untitled",
      resourceKey: resourceKey(content, submission.contentId),
      preDetected: submission.preDetected,
      existingTopics: submission.existingTopics,
      analysisSegments,
      notifyAgentId: submission.notifyAgentId,
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
      stages: pipelineStages(job.stages),
    };
  }

  async deliveryStatus(jobId: string): Promise<JobDeliveryStatusResponse[]> {
    const rows = await this.storage.list_pipeline_job_deliveries(jobId);
    return rows.map(({ id, job_id, kind, idempotency_key, status, attempt_count, next_attempt_at, last_error_code, created_at, updated_at, delivered_at }) => ({ id, job_id, kind, idempotency_key, status, attempt_count, next_attempt_at, last_error_code, created_at, updated_at, delivered_at }));
  }

  async drainDueDeliveries(): Promise<void> {
    await this.deliverDuePipelineJobDeliveries();
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
    if (TERMINAL_STATUSES.has(status)) return { job_id: resolvedId, status, message: `Job already in terminal state: ${status}` };
    const finishedAt = new Date();
    const cancelledCandidate: PipelineJob = { ...job, status: JobStatus.CANCELLED, finished_at: finishedAt };
    const intents = await this.terminalIntents(cancelledCandidate, JobStatus.CANCELLED);
    const cancelled = pipelineJob(await this.storage.transition_pipeline_job_terminal(resolvedId, JobStatus.CANCELLED, [undefined, finishedAt], [undefined, undefined, undefined], [JobStatus.PENDING], undefined, intents));
    if (cancelled !== undefined) {
      this.queueDeliveryPump();
      return { job_id: resolvedId, status: JobStatus.CANCELLED, message: "Job cancelled" };
    }
    const winner = pipelineJob(await this.storage.get_pipeline_job(resolvedId), job) ?? job;
    return { job_id: resolvedId, status: winner.status ?? status, message: `Job already in state: ${winner.status ?? status}` };
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.all([...this.tasks]);
  }

  private track(task: Promise<void>): void {
    const tracked = task.catch(() => undefined);
    this.tasks.add(tracked);
    void tracked.finally(() => this.tasks.delete(tracked));
  }

  private scheduleClaim(jobId: string, request?: PipelineRequest): void {
    this.track(this.claimAndRun(jobId, request));
  }

  private async recoverPendingJobs(): Promise<void> {
    const rows = await this.storage.list_recoverable_pipeline_jobs(new Date(), this.config.recoveryBatchSize ?? 50);
    for (const row of rows) {
      const job = pipelineJob(row);
      if (job?.id !== undefined) this.scheduleClaim(job.id);
    }
  }

  private async claimAndRun(jobId: string, preferredRequest?: PipelineRequest): Promise<void> {
    const claimToken = randomUUID();
    const now = new Date();
    const claimed = pipelineJob(await this.storage.claim_pipeline_job(jobId, claimToken, now, new Date(now.getTime() + (this.config.jobLeaseMs ?? 300_000))));
    if (claimed === undefined) return;
    emitVaultEvent(this.config.onEvent, { event: "job.claimed", job_id: jobId });
    const request = preferredRequest ?? this.restoreRequest(claimed);
    if (request === undefined) {
      await this.failMissingRequest(claimed, claimToken);
      return;
    }
    this.track(this.runWorker(claimed, { ...request, jobId, claimToken }, claimToken));
  }

  private restoreRequest(job: PipelineJob): PipelineRequest | undefined {
    const payload = valueRecord(job.request_payload);
    if (typeof payload?.contentId !== "string" || typeof payload.contentText !== "string" || typeof payload.contentType !== "string" || typeof payload.title !== "string") return undefined;
    const pipelineVersion = typeof payload.pipelineVersion === "string" ? payload.pipelineVersion : job.pipeline_version ?? this.config.pipelineVersion;
    return { ...payload, pipelineVersion } as unknown as PipelineRequest;
  }

  private async failMissingRequest(job: PipelineJob, claimToken: string): Promise<void> {
    const status = job.status ?? JobStatus.PENDING;
    const finishedAt = new Date();
    const failure = ["JOB_RECOVERY_PAYLOAD_MISSING", "The saved pipeline request is unavailable", "recovery"] as const;
    const candidate: PipelineJob = { ...job, status: JobStatus.FAILED, finished_at: finishedAt, error_code: failure[0], error_message: failure[1], error_stage: failure[2] };
    const intents = await this.terminalIntents(candidate, JobStatus.FAILED);
    const failed = await this.storage.transition_pipeline_job_terminal(job.id ?? "", JobStatus.FAILED, [undefined, finishedAt], failure, [status], claimToken, intents);
    if (failed === undefined) return;
    emitVaultEvent(this.config.onEvent, { event: "job.recovery_missing_payload", job_id: job.id ?? "", outcome: "failure", error_code: failure[0] });
    try {
      await this.storage.update_content_processing_status(job.content_id, JobStatus.FAILED);
    } catch {
      // Job state and delivery intents are already durable.
    }
    this.queueDeliveryPump();
  }

  private async beginProcessing(jobId: string, claimToken: string): Promise<boolean> {
    const started = pipelineJob(await this.storage.begin_pipeline_job(jobId, claimToken, new Date()));
    if (started === undefined) return false;
    emitVaultEvent(this.config.onEvent, { event: "job.started", job_id: jobId });
    return true;
  }

  private async runWorker(job: PipelineJob, request: PipelineRequest, claimToken: string): Promise<void> {
    const jobId = job.id ?? "";
    let lostClaim = false;
    let renewing = false;
    const leaseMs = this.config.jobLeaseMs ?? 300_000;
    const heartbeat = setInterval(() => {
      if (renewing || lostClaim) return;
      renewing = true;
      void this.storage.renew_pipeline_job_lease(jobId, claimToken, new Date(Date.now() + leaseMs))
        .then(
          (renewed) => { if (!renewed) lostClaim = true; },
          () => { /* A renewal error is indeterminate; the claim CAS remains authoritative. */ },
        )
        .finally(() => { renewing = false; });
    }, Math.max(1_000, Math.floor(leaseMs / 3)));
    let beforeStartAttempted = false;
    let beforeStartAccepted = false;
    try {
      const output = await this.pipeline.execute(request, async () => {
        beforeStartAttempted = true;
        if (lostClaim) return false;
        beforeStartAccepted = await this.beginProcessing(jobId, claimToken);
        return beforeStartAccepted;
      });
      if (output === undefined) {
        if (beforeStartAttempted) return;
        const failure = ["PIPELINE_DISABLED", "Unified pipeline is disabled", "pipeline"] as const;
        if (this.storage.transition_pipeline_job_stage !== undefined) {
          await this.storage.transition_pipeline_job_stage(jobId, PIPELINE_STAGES[0], "failed", [undefined, new Date()], [failure[0], failure[1]], ["pending"], claimToken);
          for (const stage of PIPELINE_STAGES.slice(1)) await this.storage.transition_pipeline_job_stage(jobId, stage, "skipped", [undefined, new Date()], [undefined, undefined], ["pending"], claimToken);
        }
        const failed = await this.terminalize(job, JobStatus.FAILED, [undefined, new Date()], failure, [job.status ?? JobStatus.PENDING], claimToken, undefined, request.title);
        if (failed === undefined) return;
        await this.storage.update_content_processing_status(job.content_id, JobStatus.FAILED);
        this.queueDeliveryPump();
        return;
      }
      if (lostClaim || !beforeStartAccepted) return;
      const completed = await this.terminalize(job, JobStatus.COMPLETED, [undefined, new Date()], [undefined, undefined, undefined], [JobStatus.PROCESSING], claimToken, output.resultJson, request.title);
      if (completed === undefined) return;
      this.queueDeliveryPump();
    } catch (error: unknown) {
      if (lostClaim) return;
      const failure = this.failure(error);
      const failed = await this.terminalize(job, JobStatus.FAILED, [undefined, new Date()], [failure.code, failure.message, failure.stage], [JobStatus.PROCESSING], claimToken, undefined, request.title);
      if (failed === undefined) return;
      await this.storage.update_content_processing_status(job.content_id, JobStatus.FAILED);
      this.queueDeliveryPump();
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async terminalize(
    job: PipelineJob,
    status: JobStatus,
    timing: JobTiming,
    errors: JobErrors,
    expectedStatuses: readonly JobStatus[],
    claimToken: string,
    result?: JsonObject,
    titleHint?: string,
  ): Promise<PipelineJob | undefined> {
    const current = pipelineJob(await this.storage.get_pipeline_job(job.id ?? ""), job) ?? job;
    if (current.claim_token !== undefined && current.claim_token !== null && current.claim_token !== claimToken) return undefined;
    const candidate: PipelineJob = {
      ...current,
      status,
      started_at: timing[0] ?? current.started_at,
      finished_at: timing[1] ?? current.finished_at,
      error_code: errors[0] ?? current.error_code,
      error_message: errors[1] ?? current.error_message,
      error_stage: errors[2] ?? current.error_stage,
    };
    const intents = await this.terminalIntents(candidate, status, result, titleHint);
    const row = await this.storage.transition_pipeline_job_terminal(job.id ?? "", status, timing, errors, expectedStatuses, claimToken, intents);
    const terminal = pipelineJob(row);
    if (terminal !== undefined) emitVaultEvent(this.config.onEvent, { event: "job.terminal", job_id: terminal.id ?? "", outcome: status === JobStatus.COMPLETED ? "success" : "failure", error_code: terminal.error_code ?? undefined });
    return terminal;
  }

  private async terminalIntents(job: PipelineJob, status: JobStatus, result?: JsonObject, titleHint?: string, subscriberOverride?: string): Promise<JobDeliveryIntent[]> {
    if (!isTerminalJobStatus(status)) return [];
    const intents: JobDeliveryIntent[] = [];
    if (status === JobStatus.COMPLETED) {
      const callback = this.pipeline.createCallbackIntent(job, result);
      if (callback !== undefined) intents.push(callback);
    }
    if (this.config.notify === undefined) return intents;
    const subscribers = new Set<string>();
    if (subscriberOverride !== undefined && subscriberOverride !== "") subscribers.add(subscriberOverride);
    const subscriberIds = job.metadata?.notify_agent_ids;
    if (Array.isArray(subscriberIds)) for (const subscriber of subscriberIds) if (typeof subscriber === "string" && subscriber !== "") subscribers.add(subscriber);
    const legacySubscriber = job.metadata?.notify_agent_id;
    if (typeof legacySubscriber === "string" && legacySubscriber !== "") subscribers.add(legacySubscriber);
    let content: ContentMetadata | undefined;
    if (subscribers.size > 0 && this.storage.get_content !== undefined) {
      try {
        content = await this.storage.get_content(job.content_id);
      } catch {
        // Metadata is best effort. It must not suppress a terminal notification.
      }
    }
    const storedMetadata = notificationMetadata(content);
    const resultCoverage = terminalCoverage(result);
    const resultFiltering = terminalFiltering(result?.filtering);
    const title = storedMetadata.title ?? nonEmptyText(titleHint) ?? nonEmptyText(job.metadata?.notify_title);
    const startedAt = timestamp(job.started_at);
    const finishedAt = timestamp(job.finished_at);
    const durationSeconds = job.started_at != null && job.finished_at != null
      ? Math.max(0, (job.finished_at.getTime() - job.started_at.getTime()) / 1000)
      : null;
    const summary = typeof result?.summary === "string" ? result.summary : undefined;
    const notification: JobTerminalNotification = {
      schema: JOB_TERMINAL_NOTIFICATION_SCHEMA,
      version: JOB_TERMINAL_NOTIFICATION_VERSION,
      event: "job_terminal",
      job_id: job.id ?? "",
      content_id: job.content_id,
      status,
      ...(title === undefined ? {} : { title }),
      ...(startedAt === undefined ? {} : { started_at: startedAt }),
      ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
      duration_seconds: durationSeconds,
      ...(summary === undefined ? {} : { summary }),
      ...(resultCoverage === undefined && storedMetadata.coverage === undefined ? {} : { summary_coverage: resultCoverage ?? storedMetadata.coverage }),
      ...(resultFiltering === undefined && storedMetadata.filtering === undefined ? {} : { filtering: resultFiltering ?? storedMetadata.filtering }),
      trust: "untrusted_data",
    };
    intents.push({
      kind: "notification",
      target: "",
      idempotency_key: `job:${job.id ?? ""}:terminal:*`,
      payload: notification as unknown as JsonObject,
    });
    return intents;
  }

  private async enqueueLateNotification(job: PipelineJob, subscriber: string): Promise<void> {
    const status = job.status ?? JobStatus.PENDING;
    const intents = await this.terminalIntents({ ...job, metadata: { ...job.metadata, notify_agent_ids: [], notify_agent_id: null } }, status, undefined, undefined, subscriber);
    const template = intents.find((intent) => intent.kind === "notification");
    if (template === undefined || job.id === undefined) return;
    const notification: JobDeliveryIntent = { ...template, target: subscriber, idempotency_key: `job:${job.id}:terminal:${subscriber}` };
    const inserted = await this.storage.create_terminal_pipeline_job_delivery(job.id, notification);
    if (inserted !== undefined && inserted !== null) this.queueDeliveryPump();
  }

  private queueDeliveryPump(): void {
    if (this.stopping) return;
    this.deliveryPumpRequested = true;
    if (this.deliveryPump !== undefined) return;
    const task = (async (): Promise<void> => {
      while (this.deliveryPumpRequested && !this.stopping) {
        this.deliveryPumpRequested = false;
        await this.deliverDuePipelineJobDeliveries();
      }
    })().finally(() => {
      this.deliveryPump = undefined;
      if (this.deliveryPumpRequested && !this.stopping) this.queueDeliveryPump();
    });
    this.deliveryPump = task;
    this.track(task);
  }

  private async deliverDuePipelineJobDeliveries(): Promise<void> {
    const rows = await this.storage.list_due_pipeline_job_deliveries(new Date(), this.config.deliveryBatchSize ?? 50);
    for (const row of rows) {
      const candidate = valueRecord(row);
      const id = optionalText(candidate?.id);
      if (id === undefined) continue;
      const leaseToken = randomUUID();
      const now = new Date();
      const claimed = valueRecord(await this.storage.claim_pipeline_job_delivery(id, leaseToken, now, new Date(now.getTime() + (this.config.deliveryLeaseMs ?? 300_000))));
      if (claimed === undefined) continue;
      const delivery = claimed as unknown as JobDelivery;
      emitVaultEvent(this.config.onEvent, { event: "delivery.attempt_started", job_id: delivery.job_id, delivery_kind: delivery.kind, attempt: delivery.attempt_count });
      const startedAt = Date.now();
      try {
        if (delivery.kind === "callback") {
          await this.pipeline.deliverCallback(delivery);
        } else {
          if (this.config.notify === undefined) throw new Error("notification delivery is not configured");
          const body = JSON.stringify(delivery.payload);
          await this.config.notify(delivery.target, {
            kind: "notification",
            body,
            schema: JOB_TERMINAL_NOTIFICATION_SCHEMA,
            idempotency_key: delivery.idempotency_key,
          });
        }
        const completed = await this.storage.complete_pipeline_job_delivery(id, leaseToken, new Date());
        if (!completed) throw new Error("delivery claim was lost before acknowledgement");
        emitVaultEvent(this.config.onEvent, { event: "delivery.attempt_succeeded", job_id: delivery.job_id, delivery_kind: delivery.kind, attempt: delivery.attempt_count, duration_ms: Date.now() - startedAt, outcome: "success" });
      } catch {
        const retryAt = new Date(Date.now() + deliveryRetryDelay(delivery.attempt_count, this.config.deliveryRetryBaseMs ?? 1_000, this.config.deliveryRetryMaxMs ?? 900_000));
        await this.storage.retry_pipeline_job_delivery(id, leaseToken, retryAt, "DELIVERY_FAILED");
        emitVaultEvent(this.config.onEvent, { event: "delivery.attempt_failed", job_id: delivery.job_id, delivery_kind: delivery.kind, attempt: delivery.attempt_count, duration_ms: Date.now() - startedAt, outcome: "failure", error_code: "DELIVERY_FAILED" });
      }
    }
  }

  private schedulePoll(): void {
    if (!this.started || this.stopping) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      const task = this.pollOnce().catch(() => undefined).finally(() => {
        this.pollTask = undefined;
        this.schedulePoll();
      });
      this.pollTask = task;
    }, this.config.pollIntervalMs ?? 1_000);
  }

  private async pollOnce(): Promise<void> {
    await this.recoverPendingJobs();
    this.queueDeliveryPump();
  }

  private failure(error: unknown): { code: string; message: string; stage: string } {
    if (error instanceof PipelineStageError) return { code: error.code, message: error.message.replace(/^\[[^\]]+\] [^:]+: /, "").slice(0, 500), stage: error.stage };
    return { code: "PIPELINE_EXCEPTION", message: (error instanceof Error ? error.message : String(error)).slice(0, 500), stage: "unknown" };
  }
}

export function toJobStatusResponse(job: PipelineJob, requestedId?: string): JobStatusResponse {
  return statusResponse(job, requestedId);
}
