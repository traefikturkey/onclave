import type { EmbeddingClient } from "./embeddings";
import type { ChunkModel, ContentMetadata } from "./models";

export type EmbeddingReindexStorage = {
  download(filePath: string): Promise<Buffer>;
};

export type EmbeddingReindexRepository = {
  replace_content_chunks(contentId: string, chunks: ChunkModel[]): Promise<void>;
};

export type VaultEmbeddingReindexer = {
  reindex(content: ContentMetadata): Promise<{ chunk_count: number; model: string }>;
};

export class EmbeddingReindexService implements VaultEmbeddingReindexer {
  constructor(
    private readonly storage: EmbeddingReindexStorage,
    private readonly repository: EmbeddingReindexRepository,
    private readonly embeddings: EmbeddingClient,
    private readonly model: string,
    private readonly chunkText: (text: string) => string[],
  ) {}

  async reindex(content: ContentMetadata): Promise<{ chunk_count: number; model: string }> {
    const contentId = content.id;
    if (contentId === undefined || contentId === "") throw new Error("cannot reindex content without an ID");
    const text = (await this.storage.download(content.file_path)).toString("utf8");
    const chunkTexts = this.chunkText(text);
    if (chunkTexts.length === 0) throw new Error(`content produced no chunks: ${contentId}`);
    const vectors = await this.embeddings.embedBatch(chunkTexts);
    if (vectors.length !== chunkTexts.length || vectors.some((vector) => vector.length !== 1024)) {
      throw new Error(`embedding output did not match content chunks: ${contentId}`);
    }
    await this.repository.replace_content_chunks(contentId, chunkTexts.map((chunk, index) => ({
      content_id: contentId,
      text: chunk,
      chunk_index: index,
      embedding: vectors[index],
    })));
    return { chunk_count: chunkTexts.length, model: this.model };
  }
}
