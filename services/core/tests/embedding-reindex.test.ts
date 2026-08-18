import { describe, expect, it } from "vitest";
import { EmbeddingReindexService } from "../src/vault/embedding-reindex";
import type { EmbeddingClient } from "../src/vault/embeddings";
import type { ChunkModel } from "../src/vault/models";

function embeddingClient(vectors: number[][]): EmbeddingClient {
  return {
    embed: async () => [],
    embedBatch: async () => vectors,
    embedQuery: async () => [],
    embedDocument: async () => [],
    close: async () => {},
  };
}

describe("embedding reindex service", () => {
  it("replaces chunks from stored content without running the content pipeline", async () => {
    let replacement: { contentId: string; chunks: ChunkModel[] } | undefined;
    const service = new EmbeddingReindexService(
      { download: async () => Buffer.from("stored transcript") },
      { replace_content_chunks: async (contentId, chunks) => { replacement = { contentId, chunks }; } },
      embeddingClient([
        Array.from({ length: 1024 }, () => 0.25),
        Array.from({ length: 1024 }, () => 0.5),
      ]),
      "intfloat/e5-large-v2",
      () => ["first", "second"],
    );

    await expect(service.reindex({
      id: "content-1",
      content_type: "youtube",
      mime_type: "text/plain",
      file_size: 17,
      file_path: "youtube/content-1.txt",
    })).resolves.toEqual({ chunk_count: 2, model: "intfloat/e5-large-v2" });

    expect(replacement?.contentId).toBe("content-1");
    expect(replacement?.chunks.map((chunk) => ({ text: chunk.text, index: chunk.chunk_index }))).toEqual([
      { text: "first", index: 0 },
      { text: "second", index: 1 },
    ]);
  });

  it("does not replace chunks when the provider returns the wrong dimensions", async () => {
    let replaced = false;
    const service = new EmbeddingReindexService(
      { download: async () => Buffer.from("stored transcript") },
      { replace_content_chunks: async () => { replaced = true; } },
      embeddingClient([[0.5]]),
      "intfloat/e5-large-v2",
      (text) => [text],
    );

    await expect(service.reindex({
      id: "content-1",
      content_type: "youtube",
      mime_type: "text/plain",
      file_size: 17,
      file_path: "youtube/content-1.txt",
    })).rejects.toThrow("embedding output did not match content chunks: content-1");
    expect(replaced).toBe(false);
  });
});
