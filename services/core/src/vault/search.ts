import type { VectorSearchFilters } from "./storage";

const DEFAULT_LIMIT = 20;
const MINIMUM_LIMIT = 1;
const MAXIMUM_LIMIT = 1000;
const MINIMUM_SCORE = 0.3;
const DEFAULT_EXCLUDE_TAGS = ["test"];

type SearchChunk = Record<string, unknown>;
type ContentMetadata = { title: unknown; content_type: unknown };

export type SearchStorage = {
  vector_search(embedding: number[], limit: number, filters?: VectorSearchFilters): Promise<SearchChunk[]>;
  fetch_content_metadata(contentIds: string[]): Promise<Record<string, ContentMetadata>>;
};

export type QueryEmbeddingService = {
  embedQuery(text: string): Promise<number[]>;
};

export type SearchResult = {
  id: string;
  content_type: string;
  title: string | null;
  score: number;
  snippet: string | null;
};

export type SearchResponse = {
  query: string;
  results: SearchResult[];
  total: number;
};

type BestChunk = { score: number; text: string };

function limitValue(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || !Number.isInteger(limit)) throw new Error("invalid search limit");
  return Math.min(MAXIMUM_LIMIT, Math.max(MINIMUM_LIMIT, limit));
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function roundedScore(score: number): number {
  return Number(score.toFixed(4));
}

function bestChunksPerContent(chunks: readonly SearchChunk[]): Map<string, BestChunk> {
  const best = new Map<string, BestChunk>();
  for (const chunk of chunks) {
    const contentId = stringValue(chunk.content_id);
    const score = numberValue(chunk.score);
    const text = stringValue(chunk.text);
    const current = best.get(contentId);
    if (contentId !== "" && (current === undefined || score > current.score)) best.set(contentId, { score, text });
  }
  return best;
}

function buildResults(bestPerContent: Map<string, BestChunk>, metadata: Record<string, ContentMetadata>): SearchResult[] {
  return [...bestPerContent.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .map(([id, best]) => {
      const meta = metadata[id];
      const title = meta === undefined || typeof meta.title !== "string" ? null : meta.title;
      return {
        id,
        content_type: meta === undefined ? "unknown" : stringValue(meta.content_type, "unknown"),
        title,
        score: roundedScore(best.score),
        snippet: best.text === "" ? null : best.text.slice(0, 200),
      };
    });
}

export class SearchService {
  constructor(private readonly embeddings: QueryEmbeddingService, private readonly storage: SearchStorage) {}

  async search(query: string, limit?: number): Promise<SearchResponse> {
    const resolvedLimit = limitValue(limit);
    const queryEmbedding = await this.embeddings.embedQuery(query);
    const chunks = await this.storage.vector_search(queryEmbedding, resolvedLimit, {
      exclude_tags: DEFAULT_EXCLUDE_TAGS,
      minimum_score: MINIMUM_SCORE,
    });
    const bestPerContent = bestChunksPerContent(chunks);
    const metadata = await this.storage.fetch_content_metadata([...bestPerContent.keys()]);
    const results = buildResults(bestPerContent, metadata);
    return { query, results, total: results.length };
  }
}
