import { afterEach, describe, expect, it, vi } from "vitest";
import type { JobDelivery, JobDeliveryIntent } from "../src/vault/durability";
import { initialPipelineStages, pipelineStages, type PipelineStage, type PipelineStageStatus } from "../src/vault/job-stages";
import { PipelineOrchestrator, type JobStorage } from "../src/vault/jobs";
import { DataTier, EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type EntityModel, type JsonObject, type PipelineJob } from "../src/vault/models";
import { UnifiedPipeline, type PipelineStorage } from "../src/vault/pipeline";

const RESPONSE = JSON.stringify({
  tags: ["heartbeat"],
  new_tags: [],
  tier: "B",
  tier_explanation: ["Useful"],
  quality_score: 70,
  score_explanation: ["Clear"],
  summary: "Heartbeat summary.",
  topics: [{ name: "Systems > Queues", confidence: "high", edge_type: "discusses" }],
  pre_detected_validations: [],
  additional_entities: [],
});

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

class HeartbeatStorage implements JobStorage, PipelineStorage {
  readonly jobs = new Map<string, PipelineJob>();
  readonly stageWrites: { jobId: string; stage: PipelineStage; status: PipelineStageStatus }[] = [];
  readonly terminalWrites: { jobId: string; status: JobStatus; intents: readonly JobDeliveryIntent[] }[] = [];
  readonly contentStatusWrites: { contentId: string; status: string }[] = [];
  readonly persistedContentIds: string[] = [];
  readonly renewCalls: string[] = [];
  renewHook?: (jobId: string, claimToken: string, leaseExpiresAt: Date) => Promise<boolean>;
  private entitySequence = 0;

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
    const updated: PipelineJob = {
      ...job,
      status,
      claim_token: null,
      lease_expires_at: null,
      started_at: timing[0] ?? job.started_at,
      finished_at: timing[1] ?? job.finished_at,
      error_code: errors[0] ?? job.error_code,
      error_message: errors[1] ?? job.error_message,
      error_stage: errors[2] ?? job.error_stage,
    };
    this.jobs.set(jobId, updated);
    this.terminalWrites.push({ jobId, status, intents });
    return updated;
  }

  async transition_pipeline_job_stage(jobId: string, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined], expectedStatuses: readonly PipelineStageStatus[], claimToken?: string): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || (claimToken !== undefined && job.claim_token !== claimToken)) return undefined;
    const stages = job.stages ?? pipelineStages(job.metadata?.stages);
    const previous = stages[stage];
    if (!expectedStatuses.includes(previous.status)) return undefined;
    const next = {
      ...stages,
      [stage]: {
        ...previous,
        status,
        started_at: timing[0]?.toISOString() ?? previous.started_at,
        finished_at: timing[1]?.toISOString() ?? previous.finished_at,
        error_code: errors[0] ?? previous.error_code,
        error_message: errors[1] ?? previous.error_message,
      },
    };
    this.jobs.set(jobId, { ...job, stages: next, metadata: { ...job.metadata, stages: next as unknown as JsonObject } });
    this.stageWrites.push({ jobId, stage, status });
    return this.jobs.get(jobId);
  }

  async claim_pipeline_job(jobId: string, claimToken: string, now: Date, leaseExpiresAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    if (job.claim_token != null && job.lease_expires_at != null && job.lease_expires_at > now) return undefined;
    const updated = { ...job, claim_token: claimToken, lease_expires_at: leaseExpiresAt };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async renew_pipeline_job_lease(jobId: string, claimToken: string, leaseExpiresAt: Date): Promise<boolean> {
    this.renewCalls.push(jobId);
    if (this.renewHook !== undefined) return this.renewHook(jobId, claimToken, leaseExpiresAt);
    const job = this.jobs.get(jobId);
    if (job === undefined || job.claim_token !== claimToken) return false;
    this.jobs.set(jobId, { ...job, lease_expires_at: leaseExpiresAt });
    return true;
  }

  async begin_pipeline_job(jobId: string, claimToken: string, startedAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.claim_token !== claimToken || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    const updated = { ...job, status: JobStatus.PROCESSING, started_at: job.started_at ?? startedAt };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async list_recoverable_pipeline_jobs(now: Date, limit: number): Promise<unknown[]> {
    return [...this.jobs.values()].filter((job) => [JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING) && (job.claim_token == null || job.lease_expires_at == null || job.lease_expires_at <= now)).slice(0, limit);
  }

  async create_terminal_pipeline_job_delivery(): Promise<unknown> { return undefined; }
  async list_due_pipeline_job_deliveries(): Promise<unknown[]> { return []; }
  async claim_pipeline_job_delivery(): Promise<unknown> { return undefined; }
  async complete_pipeline_job_delivery(): Promise<boolean> { return false; }
  async retry_pipeline_job_delivery(): Promise<boolean> { return false; }
  async list_pipeline_job_deliveries(): Promise<JobDelivery[]> { return []; }

  async list_pipeline_jobs(): Promise<readonly [unknown[], number]> { return [[...this.jobs.values()], this.jobs.size]; }

  async get_pipeline_job_stats(): Promise<{ total_jobs: number; completed_jobs: number; failed_jobs: number; cancelled_jobs: number; average_completion_seconds: number | null }> {
    return { total_jobs: this.jobs.size, completed_jobs: 0, failed_jobs: 0, cancelled_jobs: 0, average_completion_seconds: null };
  }

  async update_content_processing_status(contentId: string, status: string): Promise<void> {
    this.contentStatusWrites.push({ contentId, status });
  }

  async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> { return []; }
  async get_topic_hierarchy(): Promise<readonly EntityModel[]> { return []; }
  async get_tag_cooccurrence(): Promise<Record<string, string[]>> { return {}; }
  async get_tier_distribution(): Promise<Record<string, number>> { return {}; }
  async get_tag_aliases(): Promise<Record<string, string>> { return {}; }
  async record_tag_alias(): Promise<void> {}

  async find_or_create_entity(name: string, entityType: EntityType): Promise<readonly [EntityModel, boolean]> {
    this.entitySequence += 1;
    return [{ id: `entity-${this.entitySequence}`, name, normalized_name: name.toLowerCase(), entity_type: entityType }, true];
  }

  async complete_content_processing(contentId: string, _result: JsonObject, _pipelineVersion: string, _chunks: ChunkModel[], _relationships: ContentEntityEdge[]): Promise<void> {
    this.persistedContentIds.push(contentId);
  }
}

function makeHarness(storage: HeartbeatStorage, enabled = true): {
  jobs: PipelineOrchestrator;
  pipeline: UnifiedPipeline;
  firstEntered: Promise<void>;
  releaseFirst: () => void;
  providerCalls: string[];
} {
  const gate = deferred<void>();
  const entered = deferred<void>();
  const providerCalls: string[] = [];
  const pipeline = new UnifiedPipeline({
    model: "heartbeat-test",
    async generate(prompt: string): Promise<string> {
      const content = prompt.includes("first-source") ? "first" : prompt.includes("second-source") ? "second" : "unknown";
      providerCalls.push(content);
      if (content === "first") {
        entered.resolve();
        await gate.promise;
      }
      return RESPONSE;
    },
    async close(): Promise<void> {},
  }, storage, {
    unifiedPipelineEnabled: enabled,
    unifiedPipelineMaxConcurrency: 1,
    unifiedPipelineMaxNewTags: 3,
    entityMaxTopicsPerContent: 7,
    entityMinConfidence: 0.6,
    callbackUrl: "https://callback.test/jobs",
    callbackSecret: "test-secret",
  }, { chunkText: (text) => [text] }, { embedBatch: async (texts) => texts.map(() => Array.from({ length: 1024 }, () => 0.5)) });
  return {
    pipeline,
    jobs: new PipelineOrchestrator(pipeline, storage, { pipelineVersion: "1.0.0", jobLeaseMs: 3_000 }),
    firstEntered: entered.promise,
    releaseFirst: () => gate.resolve(),
    providerCalls,
  };
}

async function submit(jobs: PipelineOrchestrator, content: "first" | "second"): Promise<PipelineJob> {
  return jobs.submit({
    contentId: `${content}-content`,
    contentText: `${content}-source`,
    contentType: "markdown",
    title: content,
    resourceKey: `cid:${content}`,
  });
}

async function settleClaims(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function writesFor(storage: HeartbeatStorage, jobId: string): { stages: number; terminals: number; processingStatuses: number; persisted: number } {
  const contentId = storage.jobs.get(jobId)?.content_id;
  return {
    stages: storage.stageWrites.filter((write) => write.jobId === jobId).length,
    terminals: storage.terminalWrites.filter((write) => write.jobId === jobId).length,
    processingStatuses: storage.contentStatusWrites.filter((write) => write.contentId === contentId && write.status === JobStatus.PROCESSING).length,
    persisted: storage.persistedContentIds.filter((id) => id === contentId).length,
  };
}

async function recover(pipeline: UnifiedPipeline, storage: HeartbeatStorage): Promise<void> {
  const recovery = new PipelineOrchestrator(pipeline, storage, { pipelineVersion: "1.0.0", jobLeaseMs: 3_000 });
  await recovery.start();
  await recovery.waitForIdle();
  await recovery.stop();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("vault job heartbeat admission", () => {
  it("treats a thrown queued renewal as indeterminate and completes after semaphore admission", async () => {
    vi.useFakeTimers({ now: new Date("2026-02-01T00:00:00.000Z") });
    const storage = new HeartbeatStorage();
    const harness = makeHarness(storage);
    let threw = false;
    storage.renewHook = async (jobId, claimToken, leaseExpiresAt) => {
      const job = storage.jobs.get(jobId);
      if (job?.content_id === "second-content" && !threw) {
        threw = true;
        throw new Error("transient heartbeat failure");
      }
      if (job?.claim_token !== claimToken) return false;
      storage.jobs.set(jobId, { ...job, lease_expires_at: leaseExpiresAt });
      return true;
    };

    await submit(harness.jobs, "first");
    await harness.firstEntered;
    const second = await submit(harness.jobs, "second");
    await settleClaims();
    await vi.advanceTimersByTimeAsync(1_000);
    harness.releaseFirst();
    await harness.jobs.waitForIdle();

    expect(threw).toBe(true);
    expect(harness.providerCalls).toEqual(["first", "second"]);
    expect(storage.jobs.get(second.id ?? "")).toMatchObject({ status: JobStatus.COMPLETED });
    const [terminal] = storage.terminalWrites.filter((write) => write.jobId === second.id);
    expect(terminal?.status).toBe(JobStatus.COMPLETED);
    expect(terminal?.intents).toEqual([expect.objectContaining({ kind: "callback", payload: expect.objectContaining({ status: JobStatus.COMPLETED }) })]);
    expect(storage.jobs.get(second.id ?? "")?.error_code).not.toBe("PIPELINE_DISABLED");
  });

  it("keeps authoritative renewal loss monotonic, produces no stale side effects, and allows recovery", async () => {
    vi.useFakeTimers({ now: new Date("2026-02-01T00:00:00.000Z") });
    const storage = new HeartbeatStorage();
    const harness = makeHarness(storage);
    const lateRenewal = deferred<boolean>();

    await submit(harness.jobs, "first");
    await harness.firstEntered;
    const second = await submit(harness.jobs, "second");
    await settleClaims();
    storage.renewHook = async (jobId, claimToken, leaseExpiresAt) => {
      const job = storage.jobs.get(jobId);
      if (job?.content_id === "second-content") return lateRenewal.promise;
      if (job?.claim_token !== claimToken) return false;
      storage.jobs.set(jobId, { ...job, lease_expires_at: leaseExpiresAt });
      return true;
    };

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.renewCalls.filter((jobId) => jobId === second.id)).toHaveLength(1);
    const queued = storage.jobs.get(second.id ?? "");
    if (queued === undefined) throw new Error("queued job missing");
    storage.jobs.set(second.id ?? "", { ...queued, claim_token: null, lease_expires_at: new Date(0) });
    lateRenewal.resolve(false);
    await settleClaims();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(storage.renewCalls.filter((jobId) => jobId === second.id)).toHaveLength(1);

    harness.releaseFirst();
    await harness.jobs.waitForIdle();
    expect(harness.providerCalls).toEqual(["first"]);
    expect(writesFor(storage, second.id ?? "")).toEqual({ stages: 0, terminals: 0, processingStatuses: 0, persisted: 0 });
    expect(storage.jobs.get(second.id ?? "")?.status).toBe(JobStatus.PENDING);

    storage.renewHook = undefined;
    await recover(harness.pipeline, storage);
    expect(harness.providerCalls).toEqual(["first", "second"]);
    expect(storage.jobs.get(second.id ?? "")?.status).toBe(JobStatus.COMPLETED);
  });

  it("does not report a changed-token begin CAS failure as a disabled pipeline", async () => {
    vi.useFakeTimers({ now: new Date("2026-02-01T00:00:00.000Z") });
    const storage = new HeartbeatStorage();
    const harness = makeHarness(storage);

    await submit(harness.jobs, "first");
    await harness.firstEntered;
    const second = await submit(harness.jobs, "second");
    await settleClaims();
    const queued = storage.jobs.get(second.id ?? "");
    if (queued === undefined) throw new Error("queued job missing");
    storage.jobs.set(second.id ?? "", { ...queued, claim_token: "replacement-token", lease_expires_at: new Date(Date.now() + 60_000) });

    harness.releaseFirst();
    await harness.jobs.waitForIdle();

    expect(harness.providerCalls).toEqual(["first"]);
    expect(writesFor(storage, second.id ?? "")).toEqual({ stages: 0, terminals: 0, processingStatuses: 0, persisted: 0 });
    expect(storage.jobs.get(second.id ?? "")?.error_code).not.toBe("PIPELINE_DISABLED");

    const lost = storage.jobs.get(second.id ?? "");
    if (lost === undefined) throw new Error("lost job missing");
    storage.jobs.set(second.id ?? "", { ...lost, lease_expires_at: new Date(0) });
    await recover(harness.pipeline, storage);
    expect(storage.jobs.get(second.id ?? "")?.status).toBe(JobStatus.COMPLETED);
    expect(harness.providerCalls).toEqual(["first", "second"]);
  });

  it("still terminalizes a genuinely disabled pipeline under its current claim", async () => {
    const storage = new HeartbeatStorage();
    const harness = makeHarness(storage, false);

    const job = await submit(harness.jobs, "second");
    await harness.jobs.waitForIdle();

    expect(harness.providerCalls).toEqual([]);
    expect(storage.jobs.get(job.id ?? "")).toMatchObject({ status: JobStatus.FAILED, error_code: "PIPELINE_DISABLED", error_stage: "pipeline" });
    expect(storage.stageWrites.filter((write) => write.jobId === job.id).map(({ status }) => status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(storage.terminalWrites.filter((write) => write.jobId === job.id).map(({ status }) => status)).toEqual([JobStatus.FAILED]);
  });
});
