import { describe, expect, it } from "vitest";
import { reindexEmbeddings, type ReindexRepository, type ReindexStorage } from "../src/reindex-embeddings";
import type { EmbeddingClient } from "../src/vault/embeddings";
import type { ChunkModel, ContentMetadata } from "../src/vault/models";

function content(id: string, filePath: string): ContentMetadata {
  return {
    id,
    content_type: "youtube",
    title: id,
    mime_type: "text/plain",
    file_size: 1,
    file_path: filePath,
  };
}

describe("embedding reindex", () => {
  it("replaces chunks from stored content without running the content pipeline", async () => {
    const contents = [content("content-1", "youtube/one.txt"), content("content-2", "youtube/two.txt")];
    const replacements = new Map<string, ChunkModel[]>();
    const repository: ReindexRepository = {
      list_content: async ({ offset, limit }) => [contents.slice(offset, offset + limit), contents.length],
      replace_content_chunks: async (contentId, chunks) => {
        replacements.set(contentId, chunks);
      },
    };
    const stored = new Map([
      ["youtube/one.txt", Buffer.from("one")],
      ["youtube/two.txt", Buffer.from("two")],
    ]);
    const storage: ReindexStorage = {
      download: async (filePath) => stored.get(filePath) ?? Buffer.alloc(0),
    };
    const batches: string[][] = [];
    const embeddings: EmbeddingClient = {
      embed: async () => [],
      embedBatch: async (texts) => {
        batches.push([...texts]);
        return texts.map(() => Array.from({ length: 1024 }, () => 0.5));
      },
      embedQuery: async () => [],
      embedDocument: async () => [],
      close: async () => {},
    };

    await expect(reindexEmbeddings(repository, storage, embeddings, {
      contentType: "youtube",
      concurrency: 2,
      chunk: (text) => [text, `${text}-second`],
    })).resolves.toEqual({ content_type: "youtube", content_count: 2, chunk_count: 4 });

    expect(batches).toEqual(expect.arrayContaining([
      ["one", "one-second"],
      ["two", "two-second"],
    ]));
    expect(replacements.get("content-1")?.map((chunk) => ({ text: chunk.text, index: chunk.chunk_index }))).toEqual([
      { text: "one", index: 0 },
      { text: "one-second", index: 1 },
    ]);
  });

  it("stops before replacement when the provider returns the wrong dimensions", async () => {
    let replaced = false;
    const repository: ReindexRepository = {
      list_content: async () => [[content("content-1", "youtube/one.txt")], 1],
      replace_content_chunks: async () => {
        replaced = true;
      },
    };
    const storage: ReindexStorage = { download: async () => Buffer.from("one") };
    const embeddings: EmbeddingClient = {
      embed: async () => [],
      embedBatch: async () => [[0.5]],
      embedQuery: async () => [],
      embedDocument: async () => [],
      close: async () => {},
    };

    await expect(reindexEmbeddings(repository, storage, embeddings, {
      contentType: "youtube",
      concurrency: 1,
      chunk: (text) => [text],
    })).rejects.toThrow("embedding output did not match content chunks: content-1");
    expect(replaced).toBe(false);
  });
});
