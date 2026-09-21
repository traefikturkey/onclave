import type { EmbeddingClient } from "./embeddings";
import type { ChunkModel, ContentMetadata } from "./models";

export type EmbeddingReindexStorage = {
  download(filePath: string): Promise<Buffer>;
};

export type EmbeddingReindexRepository = {
  replace_content_chunks(contentId: string, chunks: ChunkModel[]): Promise<void>;
};

export type VaultEmbeddingReindexer = {
  reindex(content: ContentMetadata, text?: string): Promise<{ chunk_count: number; model: string }>;
};

export class EmbeddingReindexService implements VaultEmbeddingReindexer {
  constructor(
    private readonly storage: EmbeddingReindexStorage,
    private readonly repository: EmbeddingReindexRepository,
    private readonly embeddings: EmbeddingClient,
    private readonly model: string,
    private readonly chunkText: (text: string) => string[],
  ) {}

  async reindex(content: ContentMetadata, suppliedText?: string): Promise<{ chunk_count: number; model: string }> {
    const contentId = content.id;
    if (contentId === undefined || contentId === "") throw new Error("cannot reindex content without an ID");
    const text = suppliedText ?? (await this.storage.download(content.file_path)).toString("utf8");
    const chunkTexts = this.chunkText(text);
    // Empty is a valid prepared source when SponsorBlock excluded every
    // segment. Replacing with no chunks is intentional and removes stale
    // embeddings without embedding the original transcript.
    const vectors = chunkTexts.length === 0 ? [] : await this.embeddings.embedBatch(chunkTexts);
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
