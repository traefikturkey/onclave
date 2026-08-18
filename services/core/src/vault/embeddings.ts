import type { VaultConfig } from "./config";

export type OllamaFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DEFAULT_TIMEOUT_MS = 180_000;

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function embeddingFromResponse(value: unknown): number[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const embeddings = (value as Record<string, unknown>).embeddings;
  if (!Array.isArray(embeddings) || !Array.isArray(embeddings[0])) return [];
  const embedding = embeddings[0];
  return embedding.every((item) => typeof item === "number") ? embedding : [];
}

export class EmbeddingService {
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetcher: OllamaFetcher;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, fetcher: OllamaFetcher = defaultFetcher, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = baseUrl;
    this.model = model;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(new URL("/api/embed", this.baseUrl).toString(), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: this.model, input: text, truncate: true }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      } catch (error: unknown) {
        throw new Error(`Embedding generation failed: ${errorMessage(error)}`, { cause: error });
      }
      return embeddingFromResponse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    const embeddings: number[][] = [];
    for (const text of texts) embeddings.push(await this.embed(text));
    return embeddings;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embed(`${QUERY_PREFIX}${text}`);
  }

  async embedDocument(text: string): Promise<number[]> {
    return this.embed(text);
  }

  async close(): Promise<void> {}
}

export function createEmbeddingService(config: Pick<VaultConfig, "ollamaUrl" | "ollamaModel">, fetcher?: OllamaFetcher): EmbeddingService {
  return new EmbeddingService(config.ollamaUrl, config.ollamaModel, fetcher);
}
