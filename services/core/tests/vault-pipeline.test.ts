import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PipelineOrchestrator, type JobNotificationDelivery, type JobStorage } from "../src/vault/jobs";
import type { JobDelivery, JobDeliveryIntent, VaultPipelineEvent } from "../src/vault/durability";
import { MeteringLLMProvider, type MeteredLlmUsage } from "../src/vault/llm-metering";
import { LLMPricingService, type PricingSnapshotStorage } from "../src/vault/llm-pricing";
import type { LlmGenerationOptions, LlmProvider } from "../src/vault/llm-providers";
import { DataTier, EdgeType, EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type ContentMetadata, type EntityModel, type JsonObject, type PipelineJob } from "../src/vault/models";
import { initialPipelineStages, pipelineStages, type PipelineStage, type PipelineStageStatus } from "../src/vault/job-stages";
import { UnifiedPipeline, type PipelineConfig, type PipelineEmbeddingService, type PipelineStorage } from "../src/vault/pipeline";
import { chunkText } from "../src/vault/vault-service";

describe("vault transcript chunking", () => {
  it("preserves text while limiting chunks to 400 Unicode code points", () => {
    const text = `${"a".repeat(399)}😀${"b".repeat(401)}`;
    const chunks = chunkText(`\n${text}\n`);

    expect(chunks.map((chunk) => [...chunk].length)).toEqual([400, 400, 1]);
    expect(chunks.join("")).toBe(text);
  });
});

const response = JSON.stringify({
  tags: ["typescript"],
  new_tags: ["vault"],
  tier: "A",
  tier_explanation: ["Useful"],
  quality_score: 82,
  score_explanation: ["Clear"],
  summary: "A concise summary.",
  structured_summary: { version: 1, overview: "A concise summary.", key_points: ["The retained source was analyzed."] },
  topics: [{ name: "Engineering > TypeScript", confidence: "high", edge_type: "discusses" }],
  pre_detected_validations: [{ entity_id: "entity:known-tool", edge_type: "uses", confirmed: true }],
  additional_entities: [{ type: "tool", name: "Vitest", confidence: "medium", edge_type: "mentions" }],
});

class FakeStorage implements PipelineStorage, JobStorage, PricingSnapshotStorage {
  readonly jobs = new Map<string, PipelineJob>();
  readonly deliveries = new Map<string, JobDelivery>();
  readonly statuses: { contentId: string; status: string }[] = [];
  readonly usages: MeteredLlmUsage[] = [];
  readonly completions: { contentId: string; result: JsonObject; chunks: ChunkModel[]; relationships: ContentEntityEdge[] }[] = [];
  readonly aliases: [string, string][] = [];
  readonly stageTransitions: { stage: PipelineStage; status: PipelineStageStatus }[] = [];
  readonly contents = new Map<string, ContentMetadata>();
  transitionBlock?: { status: JobStatus; entered: () => void; release: Promise<void> };
  subscriberBlock?: { entered: () => void; release: Promise<void> };
  processingCasSucceeded?: () => void;
  throwCompleteDeliveryOnce = false;
  private entityCount = 0;

  async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> {
    return [{ name: "typescript", count: 2 }];
  }

  async get_topic_hierarchy(): Promise<readonly EntityModel[]> {
    return [];
  }

  async get_tag_cooccurrence(): Promise<Record<string, string[]>> {
    return {};
  }

  async get_tier_distribution(): Promise<Record<string, number>> {
    return {};
  }

  async get_tag_aliases(): Promise<Record<string, string>> {
    return {};
  }

  async record_tag_alias(variant: string, canonical: string): Promise<void> {
    this.aliases.push([variant, canonical]);
  }

  async find_or_create_entity(name: string, entityType: EntityType, values: Omit<Partial<EntityModel>, "name" | "entity_type" | "normalized_name"> = {}): Promise<readonly [EntityModel, boolean]> {
    this.entityCount += 1;
    return [{ id: `entity-${this.entityCount}`, entity_type: entityType, name, normalized_name: name.toLowerCase(), hierarchy: values.hierarchy, source: values.source }, true];
  }

  async complete_content_processing(contentId: string, result: JsonObject, _pipelineVersion: string, chunks: ChunkModel[], relationships: ContentEntityEdge[]): Promise<void> {
    this.completions.push({ contentId, result, chunks, relationships });
  }

  async create_pipeline_job(job: PipelineJob): Promise<unknown> {
    if (job.id === undefined) throw new Error("job ID is required");
    this.jobs.set(job.id, { ...job });
    return this.jobs.get(job.id);
  }

  async get_pipeline_job(jobId: string): Promise<unknown> {
    return this.jobs.get(jobId);
  }

  async find_active_pipeline_job(resourceKey: string): Promise<unknown> {
    return [...this.jobs.values()].find((job) => job.resource_key === resourceKey && (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING));
  }

  async add_pipeline_job_subscriber(jobId: string, subscriberId: string): Promise<unknown> {
    const block = this.subscriberBlock;
    if (block !== undefined) {
      this.subscriberBlock = undefined;
      block.entered();
      await block.release;
    }
    const job = this.jobs.get(jobId);
    if (job === undefined || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    const subscribers = Array.isArray(job.metadata?.notify_agent_ids) ? job.metadata.notify_agent_ids.filter((value): value is string => typeof value === "string") : [];
    const updated = { ...job, metadata: { ...job.metadata, notify_agent_ids: [...new Set([...subscribers, subscriberId])] } };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async transition_pipeline_job_stage(jobId: string, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined], expectedStatuses: readonly PipelineStageStatus[], claimToken?: string): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || (claimToken !== undefined && job.claim_token !== claimToken)) return undefined;
    const current = job.stages ?? pipelineStages(undefined);
    const previous = current[stage];
    if (!expectedStatuses.includes(previous.status)) return undefined;
    const next = { ...current, [stage]: { ...previous, status, started_at: timing[0]?.toISOString() ?? previous.started_at, finished_at: timing[1]?.toISOString() ?? previous.finished_at, error_code: errors[0] ?? previous.error_code, error_message: errors[1] ?? previous.error_message } };
    this.jobs.set(jobId, { ...job, stages: next, metadata: { ...job.metadata, stages: next as unknown as JsonObject } });
    this.stageTransitions.push({ stage, status });
    return this.jobs.get(jobId);
  }

  async update_pipeline_job(jobId: string, status: JobStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined, string | null | undefined]): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined) return undefined;
    const updated: PipelineJob = {
      ...job,
      status,
      started_at: timing[0] ?? job.started_at,
      finished_at: timing[1] ?? job.finished_at,
      error_code: errors[0] ?? job.error_code,
      error_message: errors[1] ?? job.error_message,
      error_stage: errors[2] ?? job.error_stage,
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async transition_pipeline_job_terminal(jobId: string, status: JobStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined, string | null | undefined], expectedStatuses: readonly JobStatus[], claimToken?: string, intents: readonly JobDeliveryIntent[] = []): Promise<unknown> {
    const block = this.transitionBlock?.status === status ? this.transitionBlock : undefined;
    if (block !== undefined) {
      this.transitionBlock = undefined;
      block.entered();
      await block.release;
    }
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
    for (const intent of intents) if (intent.kind !== "notification" || intent.target !== "") this.insertDelivery(jobId, intent);
    const notification = intents.find((intent) => intent.kind === "notification" && intent.target === "");
    if (notification !== undefined) {
      const subscribers = new Set<string>();
      const rawIds = updated.metadata?.notify_agent_ids;
      if (Array.isArray(rawIds)) for (const subscriber of rawIds) if (typeof subscriber === "string" && subscriber !== "") subscribers.add(subscriber);
      const legacyId = updated.metadata?.notify_agent_id;
      if (typeof legacyId === "string" && legacyId !== "") subscribers.add(legacyId);
      for (const subscriber of subscribers) this.insertDelivery(jobId, { ...notification, target: subscriber, idempotency_key: `job:${jobId}:terminal:${subscriber}` });
    }
    if (status === JobStatus.PROCESSING && expectedStatuses.includes(JobStatus.PENDING)) this.processingCasSucceeded?.();
    return updated;
  }

  private insertDelivery(jobId: string, intent: JobDeliveryIntent): JobDelivery {
    const existing = [...this.deliveries.values()].find((delivery) => delivery.idempotency_key === intent.idempotency_key);
    if (existing !== undefined) return existing;
    const now = new Date();
    const delivery: JobDelivery = { ...intent, id: `delivery-${this.deliveries.size + 1}`, job_id: jobId, status: "pending", attempt_count: 0, next_attempt_at: now, created_at: now, updated_at: now };
    this.deliveries.set(delivery.id, delivery);
    return delivery;
  }

  async claim_pipeline_job(jobId: string, claimToken: string, now: Date, leaseExpiresAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    if (job.claim_token !== null && job.claim_token !== undefined && job.lease_expires_at !== null && job.lease_expires_at !== undefined && job.lease_expires_at > now) return undefined;
    const updated = { ...job, claim_token: claimToken, lease_expires_at: leaseExpiresAt, ...(job.status === JobStatus.PROCESSING ? { stages: pipelineStages(undefined), metadata: { ...job.metadata, stages: pipelineStages(undefined) as unknown as JsonObject } } : {}) };
    this.jobs.set(jobId, updated);
    return updated;
  }

  async renew_pipeline_job_lease(jobId: string, claimToken: string, leaseExpiresAt: Date): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.claim_token !== claimToken || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return false;
    this.jobs.set(jobId, { ...job, lease_expires_at: leaseExpiresAt });
    return true;
  }

  async begin_pipeline_job(jobId: string, claimToken: string, startedAt: Date): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.claim_token !== claimToken || ![JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING)) return undefined;
    const updated = { ...job, status: JobStatus.PROCESSING, started_at: job.started_at ?? startedAt };
    this.jobs.set(jobId, updated);
    this.statuses.push({ contentId: job.content_id, status: JobStatus.PROCESSING });
    this.processingCasSucceeded?.();
    return updated;
  }

  async list_recoverable_pipeline_jobs(now: Date, limit: number): Promise<unknown[]> {
    return [...this.jobs.values()].filter((job) => [JobStatus.PENDING, JobStatus.PROCESSING].includes(job.status ?? JobStatus.PENDING) && (job.claim_token === null || job.claim_token === undefined || job.lease_expires_at === null || job.lease_expires_at === undefined || job.lease_expires_at <= now)).slice(0, limit);
  }

  async create_terminal_pipeline_job_delivery(jobId: string, intent: JobDeliveryIntent): Promise<unknown> {
    const job = this.jobs.get(jobId);
    if (job === undefined || ![JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED].includes(job.status ?? JobStatus.PENDING)) return undefined;
    return this.insertDelivery(jobId, intent);
  }

  async list_due_pipeline_job_deliveries(now: Date, limit: number): Promise<unknown[]> {
    return [...this.deliveries.values()].filter((delivery) => (delivery.status === "pending" && delivery.next_attempt_at <= now) || (delivery.status === "processing" && (delivery.lease_expires_at === undefined || delivery.lease_expires_at === null || delivery.lease_expires_at <= now))).slice(0, limit);
  }

  async claim_pipeline_job_delivery(deliveryId: string, leaseToken: string, now: Date, leaseExpiresAt: Date): Promise<unknown> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined || !((delivery.status === "pending" && delivery.next_attempt_at <= now) || (delivery.status === "processing" && (delivery.lease_expires_at === undefined || delivery.lease_expires_at === null || delivery.lease_expires_at <= now)))) return undefined;
    const claimed = { ...delivery, status: "processing" as const, lease_token: leaseToken, lease_expires_at: leaseExpiresAt, attempt_count: delivery.attempt_count + 1, updated_at: now };
    this.deliveries.set(deliveryId, claimed);
    return claimed;
  }

  async complete_pipeline_job_delivery(deliveryId: string, leaseToken: string, deliveredAt: Date): Promise<boolean> {
    if (this.throwCompleteDeliveryOnce) {
      this.throwCompleteDeliveryOnce = false;
      throw new Error("simulated acknowledgement persistence failure");
    }
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined || delivery.status !== "processing" || delivery.lease_token !== leaseToken) return false;
    this.deliveries.set(deliveryId, { ...delivery, status: "delivered", delivered_at: deliveredAt, updated_at: deliveredAt, lease_token: null, lease_expires_at: null });
    return true;
  }

  async retry_pipeline_job_delivery(deliveryId: string, leaseToken: string, nextAttemptAt: Date, errorCode: string): Promise<boolean> {
    const delivery = this.deliveries.get(deliveryId);
    if (delivery === undefined || delivery.status !== "processing" || delivery.lease_token !== leaseToken) return false;
    this.deliveries.set(deliveryId, { ...delivery, status: "pending", next_attempt_at: nextAttemptAt, updated_at: new Date(), lease_token: null, lease_expires_at: null, last_error_code: errorCode });
    return true;
  }

  async list_pipeline_job_deliveries(jobId: string): Promise<JobDelivery[]> {
    return [...this.deliveries.values()].filter((delivery) => delivery.job_id === jobId);
  }

  async list_pipeline_jobs(_contentId: string | undefined, _status: JobStatus | undefined, _limit: number, _offset: number): Promise<readonly [unknown[], number]> {
    return [[...this.jobs.values()], this.jobs.size];
  }

  async get_pipeline_job_stats(): Promise<{ total_jobs: number; completed_jobs: number; failed_jobs: number; cancelled_jobs: number; average_completion_seconds: number | null }> {
    const jobs = [...this.jobs.values()];
    const completed = jobs.filter((job) => job.status === JobStatus.COMPLETED);
    const durations = completed.flatMap((job) => job.started_at != null && job.finished_at != null ? [(job.finished_at.getTime() - job.started_at.getTime()) / 1000] : []);
    return { total_jobs: jobs.length, completed_jobs: completed.length, failed_jobs: jobs.filter((job) => job.status === JobStatus.FAILED).length, cancelled_jobs: jobs.filter((job) => job.status === JobStatus.CANCELLED).length, average_completion_seconds: durations.length === 0 ? null : durations.reduce((sum, value) => sum + value, 0) / durations.length };
  }

  async update_content_processing_status(contentId: string, status: string): Promise<void> {
    this.statuses.push({ contentId, status });
  }

  async get_content(contentId: string): Promise<ContentMetadata | undefined> {
    return this.contents.get(contentId);
  }

  async record_llm_usage(usage: MeteredLlmUsage): Promise<void> {
    this.usages.push(usage);
  }

  async get_pricing_snapshot(_snapshotId: string): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }

  async upsert_pricing_snapshot(_snapshotId: string, _pricing: JsonObject, _refreshedAt: Date, _source: string): Promise<void> {}
}

class FakeEmbeddings implements PipelineEmbeddingService {
  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => Array.from({ length: 1024 }, () => 0.5));
  }
}

function config(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    unifiedPipelineEnabled: true,
    unifiedPipelineMaxConcurrency: 2,
    unifiedPipelineMaxNewTags: 3,
    entityMaxTopicsPerContent: 7,
    entityMinConfidence: 0.6,
    ...overrides,
  };
}

function orchestrator(storage: FakeStorage, llm: LlmProvider, options: { pipeline?: PipelineConfig; fetcher?: (url: string, init?: RequestInit) => Promise<Response>; notify?: (agentId: string, delivery: JobNotificationDelivery) => Promise<void>; onEvent?: (event: Readonly<VaultPipelineEvent>) => void } = {}): PipelineOrchestrator {
  const pipeline = new UnifiedPipeline(llm, storage, { ...(options.pipeline ?? config()), onEvent: options.onEvent }, { chunkText: (text: string): string[] => [text] }, new FakeEmbeddings(), options.fetcher);
  return new PipelineOrchestrator(pipeline, storage, { pipelineVersion: "1.0.0", notify: options.notify, onEvent: options.onEvent });
}

function staticProvider(text = response): LlmProvider {
  return {
    model: "test-model",
    async generate(): Promise<string> {
      return text;
    },
    async close(): Promise<void> {},
  };
}

function sequenceProvider(responses: readonly string[]): LlmProvider & { calls: { prompt: string; options: LlmGenerationOptions | undefined }[] } {
  let index = 0;
  const calls: { prompt: string; options: LlmGenerationOptions | undefined }[] = [];
  return {
    model: "test-model",
    calls,
    async generate(prompt: string, options?: LlmGenerationOptions): Promise<string> {
      calls.push({ prompt, options });
      const output = responses[index];
      index += 1;
      return output ?? "";
    },
    async close(): Promise<void> {},
  };
}

describe("vault unified pipeline and jobs", () => {
  it("persists summary, tags, topics, entities, and metered usage on the happy path", async () => {
    const storage = new FakeStorage();
    const pricing = new LLMPricingService(storage);
    await pricing.initialize();
    const metered = new MeteringLLMProvider(staticProvider(), storage, "unused", "openai", "gpt-4o-mini", pricing);
    const jobs = orchestrator(storage, metered);

    const job = await jobs.submit({ contentId: "content-1", contentText: "TypeScript vault content", contentType: "markdown", title: "Vault", resourceKey: "cid:content-1" });
    await jobs.waitForIdle();

    expect(job?.status).toBe(JobStatus.PENDING);
    expect(storage.completions).toHaveLength(1);
    expect(storage.completions[0]?.result).toMatchObject({
      summary: "A concise summary.",
      tags: ["typescript", "vault"],
      topics: [{ name: "TypeScript" }],
      additional_entities: [{ name: "Vitest" }],
    });
    expect(storage.completions[0]?.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ edge_type: EdgeType.DISCUSSES }),
      expect.objectContaining({ edge_type: EdgeType.MENTIONS }),
      expect.objectContaining({ entity_id: "known-tool", edge_type: EdgeType.USES }),
    ]));
    expect(storage.usages).toHaveLength(1);
    expect(storage.usages[0]?.context).toBe(`pipeline:${job?.id ?? ""}`);
    expect(storage.jobs.get(job?.id ?? "")?.status).toBe(JobStatus.COMPLETED);
    expect(Object.values(storage.jobs.get(job?.id ?? "")?.stages ?? {}).map((stage) => stage.status)).toEqual(["completed", "completed", "completed", "completed", "completed", "completed"]);
  });

  it("emits structured stage, provider, and job events without source payloads", async () => {
    const storage = new FakeStorage();
    const events: VaultPipelineEvent[] = [];
    const secretSource = "source-text-that-must-not-appear-in-telemetry";
    const jobs = orchestrator(storage, staticProvider(), { onEvent: (event) => { events.push(event as VaultPipelineEvent); } });

    const job = await jobs.submit({ contentId: "content-telemetry", contentText: secretSource, contentType: "markdown", title: "Telemetry", resourceKey: "cid:telemetry" });
    await jobs.waitForIdle();

    expect(events.map(({ event }) => event)).toEqual(expect.arrayContaining(["job.claimed", "job.started", "pipeline.stage.started", "pipeline.stage.completed", "provider.request.started", "provider.request.completed", "job.terminal"]));
    expect(JSON.stringify(events)).not.toContain(secretSource);
    expect(JSON.stringify(events)).not.toContain(response);
    expect(events.every((event) => event.job_id === job.id)).toBe(true);
  });

  it("notifies the caller when terminal completion wins subscriber enrollment", async () => {
    const storage = new FakeStorage();
    let releaseTransition: (() => void) | undefined;
    let transitionEntered: (() => void) | undefined;
    const transitionReady = new Promise<void>((resolve) => { transitionEntered = resolve; });
    storage.transitionBlock = {
      status: JobStatus.COMPLETED,
      entered: () => transitionEntered?.(),
      release: new Promise<void>((resolve) => { releaseTransition = resolve; }),
    };
    let releaseSubscriber: (() => void) | undefined;
    let subscriberEntered: (() => void) | undefined;
    const subscriberReady = new Promise<void>((resolve) => { subscriberEntered = resolve; });
    storage.subscriberBlock = {
      entered: () => subscriberEntered?.(),
      release: new Promise<void>((resolve) => { releaseSubscriber = resolve; }),
    };
    const notifications: { agentId: string; delivery: JobNotificationDelivery }[] = [];
    const jobs = orchestrator(storage, staticProvider(), { notify: async (agentId, delivery) => {
      notifications.push({ agentId, delivery });
    } });

    const first = await jobs.submit({ contentId: "content-race-enrollment", contentText: "content", contentType: "youtube", title: "Race", resourceKey: "yt:race" });
    await transitionReady;
    const second = jobs.submit({ contentId: "content-race-enrollment", contentText: "content", contentType: "youtube", title: "Race", resourceKey: "yt:race", notifyAgentId: "caller-agent" });
    await subscriberReady;
    releaseTransition?.();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    releaseSubscriber?.();
    const deduplicated = await second;
    await jobs.waitForIdle();

    expect(deduplicated.id).toBe(first.id);
    expect(storage.jobs.get(first.id ?? "")?.status).toBe(JobStatus.COMPLETED);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ agentId: "caller-agent", delivery: { kind: "notification", schema: "onclave.job.terminal.v1", idempotency_key: `job:${first.id}:terminal:caller-agent` } });
    expect(JSON.parse(notifications[0]?.delivery.body ?? "")).toMatchObject({
      schema: "onclave.job.terminal.v1",
      version: 1,
      event: "job_terminal",
      job_id: first.id,
      content_id: "content-race-enrollment",
      status: "completed",
      trust: "untrusted_data",
    });
  });

  it("notifies every durable subscriber independently with terminal timing data", async () => {
    const storage = new FakeStorage();
    storage.contents.set("content-notify", {
      id: "content-notify",
      content_type: "youtube",
      title: "Stored video title",
      mime_type: "text/plain",
      file_size: 1,
      file_path: "content-notify.txt",
      metadata: {
        unified_result: {
          summary_coverage: { status: "full", source_variant: "analysis", generation_method: "single_call", source_segment_count: 2, source_range_count: 1, analyzed_segment_count: 2, analyzed_range_count: 1, analyzed_chunk_count: 1 },
        },
        transcript_analysis: {
          filtering: { outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", timing: "available", boundary_policy: "exclude_wholly_contained_preserve_partial_overlap", original_segment_count: 3, retained_segment_count: 2, excluded_segment_count: 1, excluded_segment_ids: ["segment-2"], interval_ids: ["interval-1"] },
        },
      },
    });
    const notifications: { agentId: string; delivery: JobNotificationDelivery }[] = [];
    const jobs = orchestrator(storage, staticProvider(), { notify: async (agentId, delivery) => {
      notifications.push({ agentId, delivery });
      if (agentId === "caller-agent") throw new Error("delivery failed");
    } });

    await jobs.submit({ contentId: "content-notify", contentText: "content", contentType: "youtube", title: "Video", resourceKey: "yt:video", notifyAgentId: "caller-agent" });
    await jobs.submit({ contentId: "content-notify", contentText: "content", contentType: "youtube", title: "Video", resourceKey: "yt:video", notifyAgentId: "second-agent" });
    await jobs.submit({ contentId: "content-notify", contentText: "content", contentType: "youtube", title: "Video", resourceKey: "yt:video", notifyAgentId: "second-agent" });
    await jobs.waitForIdle();

    expect(notifications).toHaveLength(2);
    expect(notifications.map(({ agentId }) => agentId)).toEqual(["caller-agent", "second-agent"]);
    const terminalJobId = [...storage.jobs.values()][0]?.id ?? "";
    expect(await jobs.deliveryStatus(terminalJobId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ idempotency_key: expect.stringMatching(/:terminal:caller-agent$/), status: "pending", attempt_count: 1, last_error_code: "DELIVERY_FAILED" }),
      expect.objectContaining({ idempotency_key: expect.stringMatching(/:terminal:second-agent$/), status: "delivered", attempt_count: 1 }),
    ]));
    expect(notifications.map(({ delivery }) => delivery.idempotency_key)).toEqual([
      expect.stringMatching(/^job:.+:terminal:caller-agent$/),
      expect.stringMatching(/^job:.+:terminal:second-agent$/),
    ]);
    expect([...storage.jobs.values()].every((job) => job.status === JobStatus.COMPLETED)).toBe(true);
    expect(notifications[0]).toMatchObject({ agentId: "caller-agent", delivery: { kind: "notification", schema: "onclave.job.terminal.v1" } });
    const notificationBody = notifications[0]?.delivery.body;
    if (notificationBody === undefined) throw new Error("completion notification was not captured");
    expect(JSON.parse(notificationBody)).toMatchObject({
      schema: "onclave.job.terminal.v1",
      version: 1,
      event: "job_terminal",
      job_id: expect.any(String),
      content_id: "content-notify",
      status: "completed",
      title: "Stored video title",
      summary: "A concise summary.\n\n- The retained source was analyzed.",
      summary_coverage: { status: "full", generation_method: "single_call" },
      filtering: { outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", timing: "available", retained_segment_count: 2, excluded_segment_count: 1 },
      trust: "untrusted_data",
    });
  });

  it("repairs an initial response with a whitespace-only topic before persisting", async () => {
    const storage = new FakeStorage();
    const initial = JSON.stringify({ tags: ["typescript"], summary: "Partial summary.", topics: [{ name: " > ", confidence: "high", edge_type: "discusses" }] });
    const corrected = JSON.stringify({
      tags: ["typescript"],
      new_tags: [],
      tier: "B",
      tier_explanation: ["Useful"],
      quality_score: 60,
      score_explanation: ["Clear"],
      summary: "Corrected summary.",
      topics: [
        { name: "Engineering > TypeScript", confidence: "high", edge_type: "discusses" },
        { name: "Engineering > Testing", confidence: "medium", edge_type: "mentions" },
        { name: "Engineering > Tooling", confidence: "medium", edge_type: "uses" },
      ],
      pre_detected_validations: [],
      additional_entities: [],
    });
    const provider = sequenceProvider([initial, corrected]);
    const jobs = orchestrator(storage, provider);

    const job = await jobs.submit({ contentId: "content-repaired", contentText: "content", contentType: "markdown", title: "Repaired", resourceKey: "cid:content-repaired" });
    await jobs.waitForIdle();

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toMatchObject({ options: { temperature: 0.1, maxTokens: 3000, timeout: 60 } });
    expect(provider.calls[1]?.prompt).toContain("\"topics\" must contain 3-7 objects");
    expect(storage.completions[0]?.result).toMatchObject({ summary: "Corrected summary.", tags: ["typescript"] });
    expect(storage.completions[0]?.result.topics).toHaveLength(3);
    expect(storage.jobs.get(job.id ?? "")?.status).toBe(JobStatus.COMPLETED);
  });

  it("fails without persistence when corrected output has only whitespace-only topics", async () => {
    const storage = new FakeStorage();
    const provider = sequenceProvider([
      JSON.stringify({ tags: ["typescript"], summary: "Partial summary.", topics: [{ name: "   ", confidence: "high", edge_type: "discusses" }] }),
      JSON.stringify({ tags: ["typescript"], summary: "Still partial.", topics: [{ name: " > ", confidence: "high", edge_type: "discusses" }], additional_entities: [] }),
    ]);
    const pipeline = new UnifiedPipeline(provider, storage, config(), { chunkText: (text: string): string[] => [text] }, new FakeEmbeddings());

    await expect(pipeline.execute({ contentId: "content-no-topics", contentText: "content", contentType: "markdown", title: "No topics", pipelineVersion: "1.0.0" })).rejects.toMatchObject({ stage: "parse", code: "PARSE_FAILED" });

    expect(provider.calls).toHaveLength(2);
    expect(storage.completions).toHaveLength(0);
  });

  it("completes an empty prepared source without embedding a fallback", async () => {
    const storage = new FakeStorage();
    let embeddingCalls = 0;
    const provider = staticProvider();
    const pipeline = new UnifiedPipeline(provider, storage, config(), { chunkText: () => [] }, {
      async embedBatch(): Promise<number[][]> {
        embeddingCalls += 1;
        return [];
      },
    });

    await expect(pipeline.execute({
      contentId: "content-all-excluded",
      contentText: "",
      contentType: "youtube",
      title: "All excluded",
      pipelineVersion: "1.0.0",
    })).resolves.toBeDefined();

    expect(embeddingCalls).toBe(0);
    expect(storage.completions[0]?.chunks).toEqual([]);
  });

  it("accepts an empty additional_entities array when valid topics exist", async () => {
    const storage = new FakeStorage();
    const provider = sequenceProvider([JSON.stringify({
      tags: ["typescript"],
      summary: "Summary.",
      topics: [{ name: "Engineering > TypeScript", confidence: "high", edge_type: "discusses" }],
      additional_entities: [],
    })]);
    const pipeline = new UnifiedPipeline(provider, storage, config(), { chunkText: (text: string): string[] => [text] }, new FakeEmbeddings());

    const output = await pipeline.execute({ contentId: "content-empty-entities", contentText: "content", contentType: "markdown", title: "Empty entities", pipelineVersion: "1.0.0" });

    expect(provider.calls).toHaveLength(1);
    expect(output?.result.additional_entities).toEqual([]);
    expect(storage.completions[0]?.relationships).toHaveLength(1);
  });

  it("terminalizes a disabled job from pending with terminal stages", async () => {
    const storage = new FakeStorage();
    const jobs = orchestrator(storage, staticProvider(), { pipeline: config({ unifiedPipelineEnabled: false }) });

    const job = await jobs.submit({ contentId: "content-disabled", contentText: "content", contentType: "markdown", title: "Disabled", resourceKey: "cid:content-disabled" });
    await jobs.waitForIdle();

    expect(job.id).toEqual(expect.any(String));
    const failed = storage.jobs.get(job.id ?? "");
    expect(failed).toMatchObject({ status: JobStatus.FAILED, error_code: "PIPELINE_DISABLED", error_stage: "pipeline" });
    expect(Object.values(failed?.stages ?? {}).map((stage) => stage.status)).toEqual(["failed", "skipped", "skipped", "skipped", "skipped", "skipped"]);
    expect(storage.stageTransitions.map(({ stage, status }) => `${stage}:${status}`)).toEqual([
      "context_fetch:failed", "llm_call:skipped", "parse:skipped", "chunking:skipped", "embedding:skipped", "persist:skipped",
    ]);
  });

  it("meters failed map attempts and fails the job without partial persistence", async () => {
    const storage = new FakeStorage();
    const pricing = new LLMPricingService(storage);
    await pricing.initialize();
    let calls = 0;
    let mapCalls = 0;
    const provider: LlmProvider = {
      model: "metered-youtube-model",
      async generate(prompt): Promise<string> {
        calls += 1;
        if (prompt.includes("<RETAINED UNIT>")) {
          mapCalls += 1;
          if (mapCalls === 2) throw new Error("second analysis unit failed");
        }
        return JSON.stringify({ note: { text: "ordered note", source_segment_ids: [] } });
      },
      async close(): Promise<void> {},
    };
    const metered = new MeteringLLMProvider(provider, storage, "unused", "openai", "gpt-4o-mini", pricing);
    const jobs = orchestrator(storage, metered, { pipeline: config({ unifiedPipelineInputBudget: 7_000 }) });
    const segments = Array.from({ length: 8 }, (_, index) => ({ source_segment_id: `segment-${index + 1}`, text: "retained ".repeat(2_000) }));

    const job = await jobs.submit({ contentId: "content-youtube-failure", contentText: "retained", contentType: "youtube", title: "Failure", resourceKey: "yt:failure", analysisSegments: segments });
    await jobs.waitForIdle();

    expect(calls).toBe(2);
    expect(mapCalls).toBe(2);
    expect(storage.usages).toHaveLength(2);
    expect(storage.usages.map((usage) => usage.output_tokens)).toEqual([14, 0]);
    expect(storage.completions).toHaveLength(0);
    expect(storage.jobs.get(job.id ?? "")?.status).toBe(JobStatus.FAILED);
    expect(storage.jobs.get(job.id ?? "")?.error_code).toBe("LLM_CALL_ERROR");
  });

  it("marks LLM failures with the pipeline error surface", async () => {
    const storage = new FakeStorage();
    const provider: LlmProvider = {
      model: "broken-model",
      async generate(): Promise<string> {
        throw new Error("provider unavailable");
      },
      async close(): Promise<void> {},
    };
    const jobs = orchestrator(storage, provider);

    const job = await jobs.submit({ contentId: "content-2", contentText: "content", contentType: "markdown", title: "Failure", resourceKey: "cid:content-2" });
    await jobs.waitForIdle();

    const failed = storage.jobs.get(job?.id ?? "");
    expect(failed).toMatchObject({ status: JobStatus.FAILED, error_code: "LLM_CALL_ERROR", error_stage: "llm_call", error_message: "provider unavailable" });
    expect(storage.statuses.at(-1)).toEqual({ contentId: "content-2", status: JobStatus.FAILED });
  });

  it("cancels a queued job before pipeline execution", async () => {
    const storage = new FakeStorage();
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const provider: LlmProvider = {
      model: "blocking-model",
      async generate(): Promise<string> {
        calls += 1;
        if (calls === 1) await firstStarted;
        return response;
      },
      async close(): Promise<void> {},
    };
    const notifications: { agentId: string; delivery: JobNotificationDelivery }[] = [];
    const jobs = orchestrator(storage, provider, { pipeline: config({ unifiedPipelineMaxConcurrency: 1 }), notify: async (agentId, delivery) => { notifications.push({ agentId, delivery }); } });

    const first = await jobs.submit({ contentId: "content-3", contentText: "first", contentType: "markdown", title: "First", resourceKey: "cid:content-3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await jobs.submit({ contentId: "content-4", contentText: "second", contentType: "markdown", title: "", resourceKey: "cid:content-4", notifyAgentId: "cancel-agent" });
    const cancelled = await jobs.cancel(second?.id ?? "");
    releaseFirst?.();
    await jobs.waitForIdle();

    expect(first).toBeDefined();
    expect(storage.jobs.get(second?.id ?? "")?.status).toBe(JobStatus.CANCELLED);
    expect(cancelled?.status).toBe(JobStatus.CANCELLED);
    expect(calls).toBe(1);
    expect(notifications).toHaveLength(1);
    expect(JSON.parse(notifications[0]?.delivery.body ?? "")).toMatchObject({ status: "cancelled", job_id: second?.id, content_id: "content-4", trust: "untrusted_data" });
    expect(JSON.parse(notifications[0]?.delivery.body ?? "").title).toBeUndefined();
  });

  it("lets completion win over cancellation without loser side effects", async () => {
    const storage = new FakeStorage();
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    storage.transitionBlock = { status: JobStatus.COMPLETED, entered: () => enteredResolve?.(), release };
    const calls: string[] = [];
    const jobs = orchestrator(storage, staticProvider(), {
      pipeline: config({ callbackUrl: "https://callback.test/jobs", callbackSecret: "secret" }),
      fetcher: async (): Promise<Response> => { calls.push("callback"); return new Response("ok"); },
    });

    const job = await jobs.submit({ contentId: "content-race-complete", contentText: "content", contentType: "markdown", title: "Race", resourceKey: "cid:race-complete" });
    await entered;
    const cancelled = await jobs.cancel(job.id ?? "");
    releaseResolve?.();
    await jobs.waitForIdle();

    expect(cancelled?.status).toBe(JobStatus.PROCESSING);
    expect(storage.jobs.get(job.id ?? "")?.status).toBe(JobStatus.COMPLETED);
    expect(storage.statuses.map((item) => item.status)).toContain(JobStatus.PROCESSING);
    expect(calls).toEqual(["callback"]);
  });

  it("lets failure win over cancellation without loser side effects", async () => {
    const storage = new FakeStorage();
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
    storage.transitionBlock = { status: JobStatus.FAILED, entered: () => enteredResolve?.(), release };
    const notifications: { body: string; delivery: JobNotificationDelivery }[] = [];
    const jobs = orchestrator(storage, {
      model: "broken-model",
      async generate(): Promise<string> { throw new Error("provider unavailable"); },
      async close(): Promise<void> {},
    }, { notify: async (_agentId, delivery): Promise<void> => { notifications.push({ body: delivery.body, delivery }); } });

    const job = await jobs.submit({ contentId: "content-race-failure", contentText: "content", contentType: "markdown", title: "Race", resourceKey: "cid:race-failure", notifyAgentId: "agent" });
    await entered;
    const cancelled = await jobs.cancel(job.id ?? "");
    releaseResolve?.();
    await jobs.waitForIdle();

    expect(cancelled?.status).toBe(JobStatus.PROCESSING);
    expect(storage.jobs.get(job.id ?? "")?.status).toBe(JobStatus.FAILED);
    expect(storage.statuses.map((item) => item.status)).toContain(JobStatus.FAILED);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ delivery: { kind: "notification", schema: "onclave.job.terminal.v1" } });
    expect(JSON.parse(notifications[0]?.body ?? "")).toMatchObject({ schema: "onclave.job.terminal.v1", event: "job_terminal", status: "failed", title: "Race", trust: "untrusted_data" });
  });

  it("does not cancel after the processing CAS wins", async () => {
    const storage = new FakeStorage();
    let releaseGenerate: (() => void) | undefined;
    const generating = new Promise<void>((resolve) => { releaseGenerate = resolve; });
    const provider: LlmProvider = {
      model: "blocking-model",
      async generate(): Promise<string> { await generating; return response; },
      async close(): Promise<void> {},
    };
    const jobs = orchestrator(storage, provider);
    let processingResolve: (() => void) | undefined;
    const processing = new Promise<void>((resolve) => { processingResolve = resolve; });
    storage.processingCasSucceeded = () => processingResolve?.();
    const job = await jobs.submit({ contentId: "content-race-processing", contentText: "content", contentType: "markdown", title: "Race", resourceKey: "cid:race-processing" });
    await processing;
    const cancelled = await jobs.cancel(job.id ?? "");
    releaseGenerate?.();
    await jobs.waitForIdle();

    expect(cancelled?.status).toBe(JobStatus.PROCESSING);
    expect(storage.jobs.get(job.id ?? "")?.status).toBe(JobStatus.COMPLETED);
    expect(storage.statuses.map((item) => item.status)).toEqual([JobStatus.PENDING, JobStatus.PROCESSING]);
  });

  it("creates a new job when reprocessing existing content", async () => {
    const storage = new FakeStorage();
    storage.contents.set("content-5", { id: "content-5", content_type: "youtube", title: "Existing", mime_type: "text/plain", file_size: 1, file_path: "content-5.txt", metadata: { video_id: "abc123" } });
    const jobs = orchestrator(storage, staticProvider());

    const job = await jobs.reprocess({ contentId: "content-5", contentText: "existing transcript" });
    await jobs.waitForIdle();

    expect(job).toMatchObject({ content_id: "content-5", resource_key: "yt:abc123" });
    expect(storage.jobs.get(job?.id ?? "")?.status).toBe(JobStatus.COMPLETED);
  });

  it("carries reprocess notification identity through terminal completion", async () => {
    const storage = new FakeStorage();
    const notifications: { agentId: string; delivery: JobNotificationDelivery }[] = [];
    const jobs = orchestrator(storage, staticProvider(), { notify: async (agentId, delivery) => { notifications.push({ agentId, delivery }); } });
    storage.contents.set("content-reprocess-notify", { id: "content-reprocess-notify", content_type: "youtube", title: "Existing", mime_type: "text/plain", file_size: 1, file_path: "content.txt", metadata: { video_id: "notify-video" } });

    const job = await jobs.reprocess({ contentId: "content-reprocess-notify", contentText: "existing transcript", notifyAgentId: "pi-test" });
    await jobs.waitForIdle();

    expect(job).toMatchObject({ content_id: "content-reprocess-notify", metadata: { notify_agent_ids: ["pi-test"] } });
    expect(notifications).toMatchObject([{ agentId: "pi-test", delivery: { kind: "notification", schema: "onclave.job.terminal.v1", idempotency_key: `job:${job?.id}:terminal:pi-test` } }]);
  });

  it("delivers the completed callback with the signed Menos payload", async () => {
    const storage = new FakeStorage();
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const jobs = orchestrator(storage, staticProvider(), {
      pipeline: config({ callbackUrl: "https://callback.test/jobs", callbackSecret: "callback-secret" }),
      fetcher: async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, init });
        return new Response("ok", { status: 200 });
      },
    });

    const job = await jobs.submit({ contentId: "content-6", contentText: "callback content", contentType: "markdown", title: "Callback", resourceKey: "cid:content-6" });
    await jobs.waitForIdle();

    expect(calls).toHaveLength(1);
    const body = calls[0]?.init?.body;
    if (typeof body !== "string") throw new Error("callback body was not a string");
    expect(calls[0]?.url).toBe("https://callback.test/jobs");
    expect(JSON.parse(body)).toMatchObject({ schema_version: "1", job_id: job?.id, content_id: "content-6", status: "completed", pipeline_version: "1.0.0", result: { summary: "A concise summary." } });
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["X-Menos-Signature"]).toBe(createHmac("sha256", "callback-secret").update(body).digest("hex"));
    expect(headers["Idempotency-Key"]).toBe(`job:${job?.id}:callback:v1`);
  });

  it("recovers pending and abandoned processing jobs from their persisted requests after restart", async () => {
    const storage = new FakeStorage();
    const prompts: string[] = [];
    const provider: LlmProvider = {
      model: "recovery-model",
      async generate(prompt): Promise<string> { prompts.push(prompt); return response; },
      async close(): Promise<void> {},
    };
    const seed = async (id: string, status: JobStatus): Promise<void> => {
      const request = { contentId: `content-${id}`, contentText: `durable input ${id}`, contentType: "markdown", title: `Recovered ${id}`, pipelineVersion: "1.0.0" };
      await storage.create_pipeline_job({
        id,
        resource_key: `cid:${id}`,
        content_id: request.contentId,
        status,
        pipeline_version: request.pipelineVersion,
        data_tier: DataTier.COMPACT,
        request_payload: request as unknown as JsonObject,
        metadata: { notify_agent_ids: [`agent-${id}`], stages: initialPipelineStages() as unknown as JsonObject },
        stages: initialPipelineStages(),
        created_at: new Date("2026-01-01T00:00:00.000Z"),
        ...(status === JobStatus.PROCESSING ? { started_at: new Date("2026-01-01T00:01:00.000Z") } : {}),
      });
    };
    await seed("restart-pending", JobStatus.PENDING);
    await seed("restart-processing", JobStatus.PROCESSING);
    const notifications: string[] = [];
    const jobs = orchestrator(storage, provider, { notify: async (agentId) => { notifications.push(agentId); } });

    await jobs.start();
    await jobs.waitForIdle();
    await jobs.stop();

    expect(storage.jobs.get("restart-pending")?.status).toBe(JobStatus.COMPLETED);
    expect(storage.jobs.get("restart-processing")?.status).toBe(JobStatus.COMPLETED);
    expect(prompts).toHaveLength(2);
    expect(prompts).toEqual(expect.arrayContaining([expect.stringContaining("durable input restart-pending"), expect.stringContaining("durable input restart-processing")]));
    expect(notifications.sort()).toEqual(["agent-restart-pending", "agent-restart-processing"]);
    expect(storage.jobs.get("restart-processing")?.started_at).toEqual(new Date("2026-01-01T00:01:00.000Z"));
  });

  it("terminalizes legacy active jobs that cannot be reconstructed from a saved request", async () => {
    const storage = new FakeStorage();
    await storage.create_pipeline_job({ id: "legacy-active", resource_key: "legacy", content_id: "legacy-content", status: JobStatus.PROCESSING, pipeline_version: "1.0.0", metadata: { notify_agent_ids: ["legacy-agent"] } });
    const delivered: string[] = [];
    const jobs = orchestrator(storage, staticProvider(), { notify: async (agentId) => { delivered.push(agentId); } });

    await jobs.start();
    await jobs.waitForIdle();
    await jobs.stop();

    expect(storage.jobs.get("legacy-active")).toMatchObject({ status: JobStatus.FAILED, error_code: "JOB_RECOVERY_PAYLOAD_MISSING" });
    expect(delivered).toEqual(["legacy-agent"]);
  });

  it("fences stale job claims and terminal writes after a lease is reclaimed", async () => {
    const storage = new FakeStorage();
    await storage.create_pipeline_job({ id: "fenced-job", resource_key: "fenced", content_id: "fenced-content", status: JobStatus.PENDING, pipeline_version: "1.0.0", metadata: {} });
    const now = new Date();
    const oldClaim = await storage.claim_pipeline_job("fenced-job", "old-token", now, new Date(now.getTime() + 60_000)) as PipelineJob;
    const current = storage.jobs.get("fenced-job");
    if (current === undefined) throw new Error("seeded job disappeared");
    storage.jobs.set("fenced-job", { ...current, lease_expires_at: new Date(0) });
    const newClaim = await storage.claim_pipeline_job("fenced-job", "new-token", new Date(), new Date(Date.now() + 60_000)) as PipelineJob;

    const staleTerminal = await storage.transition_pipeline_job_terminal("fenced-job", JobStatus.FAILED, [undefined, new Date()], ["STALE", "stale worker", "pipeline"], [JobStatus.PENDING], oldClaim.claim_token ?? undefined, [{ kind: "notification", target: "agent", idempotency_key: "stale-key", payload: {} }]);

    expect(newClaim.claim_token).toBe("new-token");
    expect(staleTerminal).toBeUndefined();
    expect(storage.jobs.get("fenced-job")?.status).toBe(JobStatus.PENDING);
    expect(storage.deliveries).toHaveLength(0);
  });

  it("retries an acknowledged callback after an acknowledgement crash with the same idempotency key", async () => {
    const storage = new FakeStorage();
    storage.throwCompleteDeliveryOnce = true;
    const calls: { body: string; key: string | undefined }[] = [];
    const jobs = orchestrator(storage, staticProvider(), {
      pipeline: config({ callbackUrl: "https://callback.test/jobs", callbackSecret: "callback-secret" }),
      fetcher: async (_url, init): Promise<Response> => {
        const headers = init?.headers as Record<string, string>;
        calls.push({ body: String(init?.body), key: headers["Idempotency-Key"] });
        return new Response("ok", { status: 200 });
      },
    });

    const job = await jobs.submit({ contentId: "content-callback-crash", contentText: "durable callback", contentType: "markdown", title: "Callback", resourceKey: "cid:callback-crash" });
    await jobs.waitForIdle();
    const [pendingDelivery] = await jobs.deliveryStatus(job.id ?? "");
    const persistedDelivery = pendingDelivery === undefined ? undefined : storage.deliveries.get(pendingDelivery.id);
    if (persistedDelivery === undefined) throw new Error("callback delivery was not persisted");
    storage.deliveries.set(persistedDelivery.id, { ...persistedDelivery, next_attempt_at: new Date(0) });
    await jobs.drainDueDeliveries();

    expect(calls).toHaveLength(2);
    expect(calls[0]?.key).toBe(`job:${job.id}:callback:v1`);
    expect(calls[1]?.key).toBe(calls[0]?.key);
    expect(calls[1]?.body).toBe(calls[0]?.body);
    expect((await jobs.deliveryStatus(job.id ?? "")).map(({ status, attempt_count }) => ({ status, attempt_count }))).toEqual([{ status: "delivered", attempt_count: 2 }]);
  });

  it("limits in-flight pipeline work to the configured concurrency", async () => {
    const storage = new FakeStorage();
    let inFlight = 0;
    let maximum = 0;
    const provider: LlmProvider = {
      model: "concurrency-model",
      async generate(): Promise<string> {
        inFlight += 1;
        maximum = Math.max(maximum, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return response;
      },
      async close(): Promise<void> {},
    };
    const jobs = orchestrator(storage, provider, { pipeline: config({ unifiedPipelineMaxConcurrency: 2 }) });

    await Promise.all(Array.from({ length: 5 }, (_, index) => jobs.submit({ contentId: `content-${index + 10}`, contentText: "content", contentType: "markdown", title: "Concurrency", resourceKey: `cid:content-${index + 10}` })));
    await jobs.waitForIdle();

    expect(maximum).toBe(2);
    expect([...storage.jobs.values()].every((job) => job.status === JobStatus.COMPLETED)).toBe(true);
  });
});
