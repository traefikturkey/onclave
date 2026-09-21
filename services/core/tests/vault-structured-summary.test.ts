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

function youtubeResponse(fields: JsonObject = {}): string {
  return JSON.stringify({
    tags: [], new_tags: [], tier: "B", tier_explanation: [], quality_score: 50, score_explanation: [],
    structured_summary: { version: 1, overview: "Canonical overview", key_points: ["Mechanism", "Result"] },
    outline: { version: 1, sections: [{ heading: "Opening", description: "The retained source starts.", source: { segment_ids: ["first"], start_seconds: 10, end_seconds: 14 } }] },
    topics: [{ name: "Topic", confidence: "high", edge_type: "discusses" }],
    pre_detected_validations: [], additional_entities: [], ...fields,
  });
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
  const output = await pipeline.execute({ contentId: "content", contentText: "content", contentType: "markdown", title: "Title", pipelineVersion: "1.0.0" });
  return { output, storage };
}

describe("structured summaries through UnifiedPipeline.execute", () => {
  it("sends late retained YouTube content in a complete single-call prompt and derives the scalar", async () => {
    const prompts: string[] = [];
    const llm: LlmProvider = {
      model: "youtube-model",
      async generate(prompt): Promise<string> { prompts.push(prompt); return youtubeResponse({ summary: "independent scalar that must be ignored" }); },
      async close(): Promise<void> {},
    };
    const storage = new Storage();
    const pipeline = new UnifiedPipeline(llm, storage, { ...config, unifiedPipelineInputBudget: 12_000 }, { chunkText: (text) => [text] }, new Embeddings());
    const late = "LATE_VIDEO_CONCLUSION";
    const output = await pipeline.execute({
      contentId: "youtube-late",
      contentText: `${"opening ".repeat(2_000)}${late}`,
      contentType: "youtube",
      title: "Long video",
      pipelineVersion: "1.0.0",
      analysisSegments: [{ source_segment_id: "first", text: `${"opening ".repeat(2_000)}${late}`, start_seconds: 10, duration_seconds: 14 }],
    });

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(late);
    expect(output?.result.structured_summary).toEqual({ version: 1, overview: "Canonical overview", key_points: ["Mechanism", "Result"] });
    expect(output?.result.summary).toBe("Canonical overview\n\n- Mechanism\n\n- Result");
    expect(output?.result.outline).toEqual({ version: 1, sections: [{ heading: "Opening", description: "The retained source starts.", source: { segment_ids: ["first"], start_seconds: 10, end_seconds: 24 } }] });
    expect(output?.result.summary_coverage).toMatchObject({ status: "full", generation_method: "single_call", source_segment_count: 1, analyzed_segment_count: 1 });
  });

  it("returns a deterministic no-call result for an entirely excluded source", async () => {
    let calls = 0;
    const llm: LlmProvider = {
      model: "youtube-model",
      async generate(): Promise<string> { calls += 1; throw new Error("must not call the model"); },
      async close(): Promise<void> {},
    };
    const storage = new Storage();
    const pipeline = new UnifiedPipeline(llm, storage, config, { chunkText: () => [] }, new Embeddings());
    const output = await pipeline.execute({ contentId: "youtube-empty", contentText: "SPONSOR_SENTINEL", contentType: "youtube", title: "Empty", pipelineVersion: "1.0.0", analysisSegments: [] });

    expect(calls).toBe(0);
    expect(output?.result.summary_coverage).toMatchObject({ status: "full", generation_method: "no_retained_content", source_segment_count: 0, analyzed_segment_count: 0 });
    expect(output?.result.outline).toEqual({ version: 1, sections: [] });
    expect(storage.persisted[0]?.summary).not.toContain("SPONSOR_SENTINEL");
  });

  it("does not put excluded source text into the repair prompt", async () => {
    const prompts: string[] = [];
    let call = 0;
    const llm: LlmProvider = {
      model: "youtube-model",
      async generate(prompt): Promise<string> {
        prompts.push(prompt);
        call += 1;
        return call === 1
          ? youtubeResponse({ topics: [{ name: " > ", confidence: "high", edge_type: "discusses" }] })
          : youtubeResponse();
      },
      async close(): Promise<void> {},
    };
    const pipeline = new UnifiedPipeline(llm, new Storage(), config, { chunkText: (text) => [text] }, new Embeddings());
    await pipeline.execute({
      contentId: "youtube-repair",
      contentText: "retained-only",
      contentType: "youtube",
      title: "Repair",
      pipelineVersion: "1.0.0",
      analysisSegments: [{ source_segment_id: "retained", text: "retained-only" }],
    });

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).not.toContain("SPONSOR_SENTINEL");
    expect(prompts[1]).not.toContain("retained-only");
  });

  it("keeps map/reduce ordered across multiple reduction levels", async () => {
    const prompts: string[] = [];
    const llm: LlmProvider = {
      model: "youtube-model",
      async generate(prompt): Promise<string> {
        prompts.push(prompt);
        if (prompt.includes("ORDERED ANALYSIS NOTES")) return youtubeResponse({ outline: { version: 1, sections: [
          { heading: "Start", description: "Start.", source: { segment_ids: ["segment-1"] } },
          { heading: "End", description: "End.", source: { segment_ids: ["segment-24"] } },
        ] } });
        if (prompt.includes("adjacent ordered analysis notes")) return JSON.stringify({ note: { text: "reduced ordered note", source_segment_ids: [] } });
        return JSON.stringify({ note: { text: `map note ${"m".repeat(6_000)}`, source_segment_ids: [] } });
      },
      async close(): Promise<void> {},
    };
    const segments = Array.from({ length: 24 }, (_, index) => ({ source_segment_id: `segment-${index + 1}`, text: `${index === 23 ? "LATE_CONCLUSION" : "content"} ${"x".repeat(5_000)}`, start_seconds: index * 10, duration_seconds: 5 }));
    const pipeline = new UnifiedPipeline(llm, new Storage(), { ...config, unifiedPipelineInputBudget: 7_000 }, { chunkText: (text) => [text] }, new Embeddings());
    const output = await pipeline.execute({ contentId: "youtube-reduced", contentText: "retained", contentType: "youtube", title: "Reduced", pipelineVersion: "1.0.0", analysisSegments: segments });

    expect(prompts.filter((prompt) => prompt.includes("retained transcript unit")).length).toBeGreaterThan(1);
    expect(prompts.some((prompt) => prompt.includes("LATE_CONCLUSION"))).toBe(true);
    expect(prompts.filter((prompt) => prompt.includes("adjacent ordered analysis notes")).length).toBeGreaterThan(1);
    expect(output?.result.summary_coverage).toMatchObject({ status: "full", generation_method: "map_reduce", source_segment_count: 24, analyzed_segment_count: 24 });
    expect(output?.result.outline?.sections.map((section) => section.heading)).toEqual(["Start", "End"]);
    expect(output?.result.outline?.sections[1]?.source).toMatchObject({ segment_ids: ["segment-24"], start_seconds: 230, end_seconds: 235 });
  });
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
