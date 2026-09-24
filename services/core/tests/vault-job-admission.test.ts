import { describe, expect, it } from "vitest";
import type { JobDelivery, JobDeliveryIntent } from "../src/vault/durability";
import type { PipelineStage, PipelineStageStatus } from "../src/vault/job-stages";
import { PipelineOrchestrator, type JobStorage } from "../src/vault/jobs";
import { EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type EntityModel, type JsonObject, type PipelineJob } from "../src/vault/models";
import { UnifiedPipeline, type PipelineRequest, type PipelineRunResult, type PipelineStorage } from "../src/vault/pipeline";

class AdmissionStorage implements JobStorage, PipelineStorage {
  readonly jobs = new Map<string, PipelineJob>();
  readonly statusWrites: string[] = [];
  readonly deliveries: string[] = [];
  contentStatus: string = JobStatus.PENDING;

  async create_pipeline_job(job: PipelineJob): Promise<unknown> {
    if (job.id === undefined) throw new Error("job ID required");
    this.jobs.set(job.id, { ...job });
    return this.jobs.get(job.id);
  }

  async get_pipeline_job(jobId: string): Promise<unknown> { return this.jobs.get(jobId); }
  async find_active_pipeline_job(resourceKey: string): Promise<unknown> {
    return [...this.jobs.values()].find((job) => job.resource_key === resourceKey && [JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING));
  }
  async add_pipeline_job_subscriber(): Promise<unknown> { return undefined; }
  async update_pipeline_job(): Promise<unknown> { return undefined; }

  async transition_pipeline_job_terminal(jobId: string, status: JobStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined, string | null | undefined], expectedStatuses: readonly JobStatus[], claimToken?: string, intents: readonly JobDeliveryIntent[] = []): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || !expectedStatuses.includes(job.status ?? JobStatus.PENDING) || (claimToken !== undefined && job.claim_token !== claimToken)) return undefined;
    const terminal: PipelineJob = {
      ...job,
      status,
      started_at: timing[0] ?? job.started_at,
      finished_at: timing[1] ?? job.finished_at,
      error_code: errors[0] ?? job.error_code,
      error_message: errors[1] ?? job.error_message,
      error_stage: errors[2] ?? job.error_stage,
      claim_token: null,
      lease_expires_at: null,
    };
    this.jobs.set(jobId, terminal);
    this.deliveries.push(...intents.map((intent) => intent.idempotency_key));
    return terminal;
  }

  async transition_pipeline_job_stage(_jobId: string, _stage: PipelineStage, _status: PipelineStageStatus, _timing: readonly [Date | null | undefined, Date | null | undefined], _errors: readonly [string | null | undefined, string | null | undefined], _expectedStatuses: readonly PipelineStageStatus[], _claimToken?: string): Promise<unknown> { return undefined; }

  async claim_pipeline_job(jobId: string, claimToken: string, _now: Date, leaseExpiresAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    const claimed = { ...job, claim_token: claimToken, lease_expires_at: leaseExpiresAt };
    this.jobs.set(jobId, claimed);
    return claimed;
  }

  async renew_pipeline_job_lease(): Promise<boolean> { return true; }

  async begin_pipeline_job(jobId: string, claimToken: string, startedAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.claim_token !== claimToken || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    const started: PipelineJob = { ...job, status: JobStatus.PROCESSING, started_at: job.started_at ?? startedAt };
    this.jobs.set(jobId, started);
    this.contentStatus = JobStatus.PROCESSING;
    this.statusWrites.push(JobStatus.PROCESSING);
    queueMicrotask(() => {
      const current = this.jobs.get(jobId);
      if (current === undefined) return;
      this.jobs.set(jobId, { ...current, status: JobStatus.COMPLETED, claim_token: null, lease_expires_at: null, finished_at: new Date() });
      this.contentStatus = JobStatus.COMPLETED;
      this.statusWrites.push(JobStatus.COMPLETED);
      this.deliveries.push("delivery-b");
    });
    return started;
  }

  async list_recoverable_pipeline_jobs(): Promise<unknown[]> { return []; }
  async create_terminal_pipeline_job_delivery(): Promise<unknown> { return undefined; }
  async list_due_pipeline_job_deliveries(): Promise<unknown[]> { return []; }
  async claim_pipeline_job_delivery(): Promise<unknown> { return undefined; }
  async complete_pipeline_job_delivery(): Promise<boolean> { return false; }
  async retry_pipeline_job_delivery(): Promise<boolean> { return false; }
  async list_pipeline_job_deliveries(): Promise<JobDelivery[]> { return []; }
  async list_pipeline_jobs(): Promise<readonly [unknown[], number]> { return [[...this.jobs.values()], this.jobs.size]; }
  async get_pipeline_job_stats(): Promise<{ total_jobs: number; completed_jobs: number; failed_jobs: number; cancelled_jobs: number; average_completion_seconds: number | null }> {
    return { total_jobs: this.jobs.size, completed_jobs: 1, failed_jobs: 0, cancelled_jobs: 0, average_completion_seconds: 0 };
  }

  async update_content_processing_status(_contentId: string, status: string): Promise<void> {
    this.contentStatus = status;
    this.statusWrites.push(status);
  }

  async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> { return []; }
  async get_topic_hierarchy(): Promise<readonly EntityModel[]> { return []; }
  async get_tag_cooccurrence(): Promise<Record<string, string[]>> { return {}; }
  async get_tier_distribution(): Promise<Record<string, number>> { return {}; }
  async get_tag_aliases(): Promise<Record<string, string>> { return {}; }
  async record_tag_alias(): Promise<void> {}
  async find_or_create_entity(name: string, entityType: EntityType): Promise<readonly [EntityModel, boolean]> {
    return [{ id: "entity-1", name, normalized_name: name.toLowerCase(), entity_type: entityType }, true];
  }
  async complete_content_processing(_contentId: string, _result: JsonObject, _pipelineVersion: string, _chunks: ChunkModel[], _relationships: ContentEntityEdge[]): Promise<void> {}
}

class AdmissionPipeline extends UnifiedPipeline {
  constructor(storage: AdmissionStorage) {
    super(
      { model: "unused", generate: async () => "{}", close: async () => {} },
      storage,
      {
        unifiedPipelineEnabled: true,
        unifiedPipelineMaxConcurrency: 1,
        unifiedPipelineMaxNewTags: 1,
        entityMaxTopicsPerContent: 1,
        entityMinConfidence: 0.5,
        callbackUrl: "https://callback.test/jobs",
        callbackSecret: "test-secret",
      },
      { chunkText: (text) => [text] },
      { embedBatch: async () => [] },
    );
  }

  override async execute(_request: PipelineRequest, beforeStart?: () => Promise<boolean>): Promise<PipelineRunResult | undefined> {
    if (beforeStart !== undefined && !await beforeStart()) return undefined;
    await Promise.resolve();
    return { result: { summary: "stale A" }, resultJson: { summary: "stale A" } };
  }
}

describe("vault claimed job admission", () => {
  it("does not let delayed claimant A overwrite B terminal content or create stale delivery", async () => {
    const storage = new AdmissionStorage();
    const jobs = new PipelineOrchestrator(new AdmissionPipeline(storage), storage, { pipelineVersion: "1.0.0" });

    const submitted = await jobs.submit({
      contentId: "content-1",
      contentText: "source",
      contentType: "markdown",
      title: "Admission race",
      resourceKey: "cid:content-1",
    });
    await jobs.waitForIdle();

    expect(storage.jobs.get(submitted.id ?? "")).toMatchObject({ status: JobStatus.COMPLETED, claim_token: null });
    expect(storage.contentStatus).toBe(JobStatus.COMPLETED);
    expect(storage.statusWrites).toEqual([JobStatus.PENDING, JobStatus.PROCESSING, JobStatus.COMPLETED]);
    expect(storage.deliveries).toEqual(["delivery-b"]);
  });
});
