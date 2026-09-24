import { describe, expect, it } from "vitest";
import { initialPipelineStages, type PipelineStage, type PipelineStageStatus } from "../src/vault/job-stages";
import { EdgeType, EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type EntityModel, type JsonObject } from "../src/vault/models";
import { UnifiedPipeline, type PipelineConfig, type PipelineFinalizationOptions, type PipelineStorage } from "../src/vault/pipeline";

function response(label: "A" | "B"): string {
  return JSON.stringify({
    tags: ["typescript"],
    new_tags: [label === "A" ? "typescrip" : "typescriptx"],
    tier: "A",
    quality_score: label === "A" ? 91 : 82,
    summary: `result-${label}`,
    topics: [{ name: `Topic ${label}`, confidence: "high", edge_type: "discusses" }],
    pre_detected_validations: [],
    additional_entities: [],
  });
}

const config: PipelineConfig = {
  unifiedPipelineEnabled: true,
  unifiedPipelineMaxConcurrency: 1,
  unifiedPipelineMaxNewTags: 3,
  entityMaxTopicsPerContent: 7,
  entityMinConfidence: 0.5,
};

class FencedStorage implements PipelineStorage {
  claimToken = "claim-a";
  status: JobStatus = JobStatus.PROCESSING;
  stages = initialPipelineStages();
  aliases: [string, string][] = [];
  chunks: ChunkModel[] = [];
  relationships: ContentEntityEdge[] = [];
  result: JsonObject | undefined;
  contentStatus = JobStatus.PROCESSING;
  deliveries: string[] = [];
  stageWrites = 0;
  externalPersistCompletions = 0;
  directAliases: [string, string][] = [];
  directEntityWrites = 0;
  finalizerEntered?: () => void;
  finalizerRelease?: Promise<void>;

  async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> { return [{ name: "typescript", count: 1 }]; }
  async get_topic_hierarchy(): Promise<readonly EntityModel[]> { return []; }
  async get_tag_cooccurrence(): Promise<Record<string, string[]>> { return {}; }
  async get_tier_distribution(): Promise<Record<string, number>> { return {}; }
  async get_tag_aliases(): Promise<Record<string, string>> { return {}; }
  async record_tag_alias(variant: string, canonical: string): Promise<void> { this.directAliases.push([variant, canonical]); }
  async find_or_create_entity(name: string, entityType: EntityType): Promise<readonly [EntityModel, boolean]> {
    this.directEntityWrites += 1;
    return [{ id: `direct:${name}`, name, normalized_name: name.toLowerCase(), entity_type: entityType }, true];
  }

  async transition_pipeline_job_stage(_jobId: string, stage: PipelineStage, next: PipelineStageStatus, _timing: readonly [Date | null | undefined, Date | null | undefined], _errors: readonly [string | null | undefined, string | null | undefined], expected: readonly PipelineStageStatus[], claimToken?: string): Promise<unknown> {
    if (this.status !== JobStatus.PROCESSING || claimToken !== this.claimToken || !expected.includes(this.stages[stage].status)) return undefined;
    this.stages = { ...this.stages, [stage]: { ...this.stages[stage], status: next } };
    this.stageWrites += 1;
    if (stage === "persist" && next === "completed") this.externalPersistCompletions += 1;
    return { id: "job-1" };
  }

  async complete_content_processing(_contentId: string, result: JsonObject, _pipelineVersion: string, chunks: ChunkModel[], relationships: ContentEntityEdge[], finalization?: PipelineFinalizationOptions): Promise<boolean> {
    if (finalization === undefined) {
      this.result = result;
      this.chunks = chunks;
      this.relationships = relationships;
      this.contentStatus = JobStatus.COMPLETED;
      return true;
    }
    if (finalization.claimToken === "claim-a") {
      this.finalizerEntered?.();
      await this.finalizerRelease;
    }
    if (this.status !== JobStatus.PROCESSING || finalization.claimToken !== this.claimToken || this.stages.persist.status !== "processing") return false;
    const entityIds = new Map(finalization.entities.map((entity) => [entity.referenceId, `entity:${entity.name}`]));
    this.aliases = finalization.aliases.map(([variant, canonical]) => [variant, canonical]);
    this.chunks = chunks.map((chunk) => ({ ...chunk }));
    this.relationships = relationships.map((edge) => ({ ...edge, entity_id: entityIds.get(edge.entity_id) ?? edge.entity_id }));
    this.result = result;
    this.contentStatus = JobStatus.COMPLETED;
    this.stages = { ...this.stages, persist: { ...this.stages.persist, status: "completed" } };
    return true;
  }

  reclaim(token: string): void {
    this.claimToken = token;
    this.status = JobStatus.PROCESSING;
    this.stages = initialPipelineStages();
  }
}

function pipeline(storage: FencedStorage, label: "A" | "B"): UnifiedPipeline {
  return new UnifiedPipeline(
    { model: `model-${label}`, generate: async () => response(label), close: async () => {} },
    storage,
    config,
    { chunkText: (text) => [text] },
    { embedBatch: async (texts) => texts.map(() => Array.from({ length: 1024 }, () => label === "A" ? 1 : 2)) },
  );
}

describe("vault claimed pipeline finalization fencing", () => {
  it("prevents stale claimant A from overwriting reclaimed and terminalized B", async () => {
    const storage = new FencedStorage();
    let releaseA: (() => void) | undefined;
    const blockedA = new Promise<void>((resolve) => { storage.finalizerEntered = resolve; });
    storage.finalizerRelease = new Promise<void>((resolve) => { releaseA = resolve; });

    const runA = pipeline(storage, "A").execute({ contentId: "content-1", contentText: "source-A", contentType: "markdown", title: "A", pipelineVersion: "1.0.0", jobId: "job-1", claimToken: "claim-a" });
    await blockedA;

    storage.reclaim("claim-b");
    await pipeline(storage, "B").execute({ contentId: "content-1", contentText: "source-B", contentType: "markdown", title: "B", pipelineVersion: "1.0.0", jobId: "job-1", claimToken: "claim-b" });
    storage.status = JobStatus.COMPLETED;
    storage.deliveries.push("outbox-B");
    releaseA?.();

    await expect(runA).rejects.toThrow("JOB_CLAIM_LOST");
    expect(storage.result?.summary).toBe("result-B");
    expect(storage.chunks.map((chunk) => chunk.text)).toEqual(["source-B"]);
    expect(storage.relationships).toEqual([expect.objectContaining({ entity_id: "entity:Topic B", edge_type: EdgeType.DISCUSSES })]);
    expect(storage.aliases).toEqual([["typescriptx", "typescript"]]);
    expect(storage.status).toBe(JobStatus.COMPLETED);
    expect(storage.contentStatus).toBe(JobStatus.COMPLETED);
    expect(storage.deliveries).toEqual(["outbox-B"]);
    expect(storage.directAliases).toEqual([]);
    expect(storage.directEntityWrites).toBe(0);
    expect(storage.externalPersistCompletions).toBe(0);
  });

  it("rejects a claimed request without a token before any pipeline write", async () => {
    const storage = new FencedStorage();

    await expect(pipeline(storage, "A").execute({ contentId: "content-1", contentText: "source-A", contentType: "markdown", title: "A", pipelineVersion: "1.0.0", jobId: "job-1" })).rejects.toThrow("JOB_CLAIM_TOKEN_REQUIRED");

    expect(storage.stageWrites).toBe(0);
    expect(storage.result).toBeUndefined();
    expect(storage.aliases).toEqual([]);
  });

  it("keeps direct unclaimed pipeline callers compatible", async () => {
    const storage = new FencedStorage();

    await expect(pipeline(storage, "A").execute({ contentId: "content-direct", contentText: "direct", contentType: "markdown", title: "Direct", pipelineVersion: "1.0.0" })).resolves.toBeDefined();

    expect(storage.directAliases).toEqual([["typescrip", "typescript"]]);
    expect(storage.directEntityWrites).toBe(1);
    expect(storage.relationships).toEqual([expect.objectContaining({ entity_id: "direct:Topic A", edge_type: EdgeType.DISCUSSES })]);
    expect(storage.result?.summary).toBe("result-A");
  });
});
