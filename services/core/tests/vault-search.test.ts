import { describe, expect, it } from "vitest";
import { createEmbeddingService, EmbeddingService, OpenRouterEmbeddingService, type OllamaFetcher } from "../src/vault/embeddings";
import { SearchService, type SearchStorage } from "../src/vault/search";
import type { VectorSearchFilters } from "../src/vault/storage";

type FetchCall = { url: string; init: RequestInit | undefined };

class FakeStorage implements SearchStorage {
  readonly vectorCalls: Array<{ embedding: number[]; limit: number; filters: VectorSearchFilters | undefined }> = [];
  readonly metadataCalls: string[][] = [];

  constructor(
    private readonly chunks: Record<string, unknown>[],
    private readonly metadata: Record<string, { title: unknown; content_type: unknown }>,
  ) {}

  async vector_search(embedding: number[], limit: number, filters?: VectorSearchFilters): Promise<Record<string, unknown>[]> {
    this.vectorCalls.push({ embedding, limit, filters });
    return this.chunks;
  }

  async fetch_content_metadata(contentIds: string[]): Promise<Record<string, { title: unknown; content_type: unknown }>> {
    this.metadataCalls.push(contentIds);
    return this.metadata;
  }
}

describe("Ollama embeddings", () => {
  it("posts the configured model and query prefix to the Menos Ollama endpoint", async () => {
    const calls: FetchCall[] = [];
    const fetcher: OllamaFetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ embeddings: [[0.25, -0.5]] }), { status: 200 });
    };
    const service = new EmbeddingService("http://ollama:11434/", "mxbai-embed-large", fetcher);

    await expect(service.embedQuery("find notes")).resolves.toEqual([0.25, -0.5]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://ollama:11434/api/embed");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "mxbai-embed-large",
      input: "Represent this sentence for searching relevant passages: find notes",
      truncate: true,
    });
  });

  it("wraps Ollama failures as embedding generation failures", async () => {
    const service = new EmbeddingService("http://ollama:11434", "mxbai-embed-large", async () => {
      return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
    });

    await expect(service.embed("document")).rejects.toThrow("Embedding generation failed: HTTP 503 Service Unavailable");
  });
});

describe("OpenRouter embeddings", () => {
  it("batches inputs and restores response index order", async () => {
    const calls: FetchCall[] = [];
    const fetcher: OllamaFetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        data: [
          { index: 1, embedding: [0.3, 0.4] },
          { index: 0, embedding: [0.1, 0.2] },
        ],
      }), { status: 200 });
    };
    const service = new OpenRouterEmbeddingService("openrouter-key", "intfloat/e5-large-v2", fetcher);

    await expect(service.embedBatch(["first", "second"])).resolves.toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.headers).toEqual({
      authorization: "Bearer openrouter-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "intfloat/e5-large-v2",
      input: ["passage: first", "passage: second"],
    });
  });

  it("uses the E5 query prefix for semantic search", async () => {
    const calls: FetchCall[] = [];
    const service = new OpenRouterEmbeddingService("openrouter-key", "intfloat/e5-large-v2", async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), { status: 200 });
    });

    await expect(service.embedQuery("find notes")).resolves.toEqual([0.1, 0.2]);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: "intfloat/e5-large-v2",
      input: ["query: find notes"],
    });
  });

  it("requires a key when selected by configuration", () => {
    expect(() => createEmbeddingService({
      embeddingProvider: "openrouter",
      embeddingModel: "intfloat/e5-large-v2",
      ollamaUrl: "http://ollama:11434",
      openrouterApiKey: undefined,
    })).toThrow("openrouter_api_key must be set when using openrouter embedding provider");
  });
});

describe("semantic search", () => {
  it("deduplicates chunks, shapes snippets and identifying fields, and applies search defaults", async () => {
    const longText = "x".repeat(201);
    const storage = new FakeStorage(
      [
        { content_id: "content-a", score: 0.87654, text: "Annotation text" },
        { content_id: "content-b", score: 0.912345, text: longText },
        { content_id: "content-b", score: 0.5, text: "Lower-scoring chunk" },
      ],
      {
        "content-a": { title: null, content_type: "annotation" },
        "content-b": { title: "Video", content_type: "youtube" },
      },
    );
    const embeddings = { embedQuery: async (query: string): Promise<number[]> => (query === "notes" ? [1, 2] : []) };
    const service = new SearchService(embeddings, storage);

    await expect(service.search("notes")).resolves.toEqual({
      query: "notes",
      total: 2,
      results: [
        { id: "content-b", content_type: "youtube", title: "Video", score: 0.9123, snippet: "x".repeat(200) },
        { id: "content-a", content_type: "annotation", title: null, score: 0.8765, snippet: "Annotation text" },
      ],
    });
    expect(storage.vectorCalls).toEqual([{
      embedding: [1, 2],
      limit: 20,
      filters: { exclude_tags: ["test"], minimum_score: 0.3 },
    }]);
    expect(storage.metadataCalls).toEqual([["content-a", "content-b"]]);
  });

  it("clamps the search limit to the storage range", async () => {
    const storage = new FakeStorage([], {});
    const service = new SearchService({ embedQuery: async (): Promise<number[]> => [1] }, storage);

    await service.search("notes", 10_000);

    expect(storage.vectorCalls[0]?.limit).toBe(1000);
  });

  it("returns an empty response when no chunks match", async () => {
    const storage = new FakeStorage([], {});
    const service = new SearchService({ embedQuery: async (): Promise<number[]> => [1] }, storage);

    await expect(service.search("missing", 5)).resolves.toEqual({ query: "missing", results: [], total: 0 });
    expect(storage.metadataCalls).toEqual([[]]);
  });
});
