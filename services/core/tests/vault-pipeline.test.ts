import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PipelineOrchestrator, type JobStorage } from "../src/vault/jobs";
import { MeteringLLMProvider, type MeteredLlmUsage } from "../src/vault/llm-metering";
import { LLMPricingService, type PricingSnapshotStorage } from "../src/vault/llm-pricing";
import type { LlmProvider } from "../src/vault/llm-providers";
import { EdgeType, EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type ContentMetadata, type EntityModel, type JsonObject, type PipelineJob } from "../src/vault/models";
import { UnifiedPipeline, type PipelineConfig, type PipelineEmbeddingService, type PipelineStorage } from "../src/vault/pipeline";

const response = JSON.stringify({
  tags: ["typescript"],
  new_tags: ["vault"],
  tier: "A",
  tier_explanation: ["Useful"],
  quality_score: 82,
  score_explanation: ["Clear"],
  summary: "A concise summary.",
  topics: [{ name: "Engineering > TypeScript", confidence: "high", edge_type: "discusses" }],
  pre_detected_validations: [{ entity_id: "entity:known-tool", edge_type: "uses", confirmed: true }],
  additional_entities: [{ type: "tool", name: "Vitest", confidence: "medium", edge_type: "mentions" }],
});

class FakeStorage implements PipelineStorage, JobStorage, PricingSnapshotStorage {
  readonly jobs = new Map<string, PipelineJob>();
  readonly statuses: { contentId: string; status: string }[] = [];
  readonly usages: MeteredLlmUsage[] = [];
  readonly completions: { contentId: string; result: JsonObject; chunks: ChunkModel[]; relationships: ContentEntityEdge[] }[] = [];
  readonly aliases: [string, string][] = [];
  readonly contents = new Map<string, ContentMetadata>();
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

  async list_pipeline_jobs(_contentId: string | undefined, _status: JobStatus | undefined, _limit: number, _offset: number): Promise<readonly [unknown[], number]> {
    return [[...this.jobs.values()], this.jobs.size];
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

function orchestrator(storage: FakeStorage, llm: LlmProvider, options: { pipeline?: PipelineConfig; fetcher?: (url: string, init?: RequestInit) => Promise<Response> } = {}): PipelineOrchestrator {
  const pipeline = new UnifiedPipeline(llm, storage, options.pipeline ?? config(), { chunkText: (text: string): string[] => [text] }, new FakeEmbeddings(), options.fetcher);
  return new PipelineOrchestrator(pipeline, storage, { pipelineVersion: "1.0.0" });
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
  });

  it("creates a terminal failed job when the pipeline is disabled", async () => {
    const storage = new FakeStorage();
    const jobs = orchestrator(storage, staticProvider(), { pipeline: config({ unifiedPipelineEnabled: false }) });

    const job = await jobs.submit({ contentId: "content-disabled", contentText: "content", contentType: "markdown", title: "Disabled", resourceKey: "cid:content-disabled" });
    await jobs.waitForIdle();

    expect(job.id).toEqual(expect.any(String));
    expect(storage.jobs.get(job.id ?? "")).toMatchObject({ status: JobStatus.FAILED, error_code: "PIPELINE_DISABLED" });
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
    const jobs = orchestrator(storage, provider, { pipeline: config({ unifiedPipelineMaxConcurrency: 1 }) });

    const first = await jobs.submit({ contentId: "content-3", contentText: "first", contentType: "markdown", title: "First", resourceKey: "cid:content-3" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = await jobs.submit({ contentId: "content-4", contentText: "second", contentType: "markdown", title: "Second", resourceKey: "cid:content-4" });
    await jobs.cancel(second?.id ?? "");
    releaseFirst?.();
    await jobs.waitForIdle();

    expect(first).toBeDefined();
    expect(storage.jobs.get(second?.id ?? "")?.status).toBe(JobStatus.CANCELLED);
    expect(calls).toBe(1);
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
