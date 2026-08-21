import { describe, expect, it } from "vitest";
import type { ChunkModel, ContentEntityEdge, EntityModel, EntityType, JsonObject } from "../src/vault/models";
import type { LlmProvider } from "../src/vault/llm-providers";
import { UnifiedPipeline, type PipelineConfig, type PipelineEmbeddingService, type PipelineStorage } from "../src/vault/pipeline";

class Storage implements PipelineStorage {
  readonly persisted: JsonObject[] = [];

  async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> { return []; }
  async get_topic_hierarchy(): Promise<readonly EntityModel[]> { return []; }
  async get_tag_cooccurrence(): Promise<Record<string, string[]>> { return {}; }
  async get_tier_distribution(): Promise<Record<string, number>> { return {}; }
  async get_tag_aliases(): Promise<Record<string, string>> { return {}; }
  async record_tag_alias(): Promise<void> {}
  async find_or_create_entity(name: string, entityType: EntityType, values: Omit<Partial<EntityModel>, "name" | "entity_type" | "normalized_name"> = {}): Promise<readonly [EntityModel, boolean]> {
    return [{ id: name, entity_type: entityType, name, normalized_name: name, hierarchy: values.hierarchy }, true];
  }
  async complete_content_processing(_contentId: string, result: JsonObject, _version: string, _chunks: ChunkModel[], _relationships: ContentEntityEdge[]): Promise<void> {
    this.persisted.push(result);
  }
}

class Embeddings implements PipelineEmbeddingService {
  async embedBatch(texts: readonly string[]): Promise<number[][]> { return texts.map(() => Array.from({ length: 1024 }, () => 0)); }
}

const config: PipelineConfig = {
  unifiedPipelineEnabled: true,
  unifiedPipelineMaxConcurrency: 1,
  unifiedPipelineMaxNewTags: 3,
  entityMaxTopicsPerContent: 7,
  entityMinConfidence: 0.6,
};

function provider(responses: readonly string[]): LlmProvider & { calls: number } {
  let index = 0;
  const result = {
    model: "test-model",
    calls: 0,
    async generate(): Promise<string> { result.calls += 1; return responses[index++] ?? ""; },
    async close(): Promise<void> {},
  };
  return result;
}

function response(fields: JsonObject): string {
  return JSON.stringify({
    tags: [], new_tags: [], tier: "B", tier_explanation: [], quality_score: 50, score_explanation: [],
    summary: "legacy", topics: [{ name: "Topic", confidence: "high", edge_type: "discusses" }],
    additional_entities: [], ...fields,
  });
}

async function execute(llm: LlmProvider, storage = new Storage()): Promise<{ output: Awaited<ReturnType<UnifiedPipeline["execute"]>>; storage: Storage }> {
  const pipeline = new UnifiedPipeline(llm, storage, config, { chunkText: (text) => [text] }, new Embeddings());
  const output = await pipeline.execute({ contentId: "content", contentText: "content", contentType: "youtube", title: "Title", pipelineVersion: "1.0.0" });
  return { output, storage };
}

describe("structured summaries through UnifiedPipeline.execute", () => {
  it("parses version 1 and normalizes whitespace", async () => {
    const { output } = await execute(provider([response({ structured_summary: { version: 1, overview: "  Overview  ", key_points: [" first ", "second  ", "   "] } })]));
    expect(output?.result.structured_summary).toEqual({ version: 1, overview: "Overview", key_points: ["first", "second"] });
  });

  it("normalizes observable string version 1", async () => {
    const { output } = await execute(provider([response({ structured_summary: { version: "1", overview: "Overview", key_points: ["Point"] } })]));
    expect(output?.result.structured_summary?.version).toBe(1);
  });

  it("keeps legacy scalar summaries without persisting structured_summary", async () => {
    const { output, storage } = await execute(provider([response({})]));
    expect(output?.result.summary).toBe("legacy");
    expect(output?.result.structured_summary).toBeUndefined();
    expect(storage.persisted[0]).not.toHaveProperty("structured_summary");
  });

  it("persists the canonical structured result serialization", async () => {
    const { output, storage } = await execute(provider([response({ structured_summary: { version: "1", overview: " Overview ", key_points: [" Point "] } })]));
    expect(storage.persisted[0]).toMatchObject({ structured_summary: { version: 1, overview: "Overview", key_points: ["Point"] }, model: "test-model", processed_at: expect.any(String) });
    expect(storage.persisted[0]).toEqual(expect.objectContaining({ summary: "legacy", structured_summary: { version: 1, overview: "Overview", key_points: ["Point"] } }));
    expect(output?.resultJson.structured_summary).toEqual(storage.persisted[0]?.structured_summary);
  });

  it("omits invalid structured input while preserving the valid pipeline result", async () => {
    const { output, storage } = await execute(provider([response({ structured_summary: { version: 2, overview: "Overview", key_points: ["Point"] } })]));
    expect(output?.result.structured_summary).toBeUndefined();
    expect(storage.persisted[0]).not.toHaveProperty("structured_summary");
  });

  it("exposes repair through public execution", async () => {
    const llm = provider([response({ structured_summary: { version: 1, overview: "bad", key_points: [] }, topics: [{ name: " > " }] }), response({ structured_summary: { version: "1", overview: " repaired ", key_points: [" point "] }, topics: [{ name: "Topic" }, { name: "Second" }, { name: "Third" }] })]);
    const { output, storage } = await execute(llm);
    expect(llm.calls).toBe(2);
    expect(output?.result.structured_summary).toEqual({ version: 1, overview: "repaired", key_points: ["point"] });
    expect(storage.persisted[0]).toHaveProperty("structured_summary");
  });
});
