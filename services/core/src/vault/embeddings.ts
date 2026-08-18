import type { VaultConfig } from "./config";

export type EmbeddingFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type OllamaFetcher = EmbeddingFetcher;

export type EmbeddingClient = {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: readonly string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  embedDocument(text: string): Promise<number[]>;
  close(): Promise<void>;
};

const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
const DEFAULT_TIMEOUT_MS = 180_000;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numericEmbedding(value: unknown): number[] {
  return Array.isArray(value) && value.every((item) => typeof item === "number") ? value : [];
}

function ollamaEmbeddingFromResponse(value: unknown): number[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const embeddings = (value as Record<string, unknown>).embeddings;
  return Array.isArray(embeddings) ? numericEmbedding(embeddings[0]) : [];
}

function openRouterInput(model: string, kind: "query" | "passage", text: string): string {
  return model.includes("/e5-") ? `${kind}: ${text}` : kind === "query" ? `${QUERY_PREFIX}${text}` : text;
}

function openRouterEmbeddingsFromResponse(value: unknown): number[][] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const indexed = data.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const embedding = numericEmbedding(record.embedding);
    return Number.isInteger(record.index) && embedding.length > 0
      ? [{ index: record.index as number, embedding }]
      : [];
  });
  return indexed.sort((left, right) => left.index - right.index).map((item) => item.embedding);
}

export class EmbeddingService implements EmbeddingClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly fetcher: EmbeddingFetcher;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, model: string, fetcher: EmbeddingFetcher = defaultFetcher, timeoutMs = DEFAULT_TIMEOUT_MS) {
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
      return ollamaEmbeddingFromResponse(await response.json());
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

export class OpenRouterEmbeddingService implements EmbeddingClient {
  readonly baseUrl: string;
  readonly model: string;
  private readonly apiKey: string;
  private readonly fetcher: EmbeddingFetcher;
  private readonly timeoutMs: number;

  constructor(apiKey: string, model: string, fetcher: EmbeddingFetcher = defaultFetcher, timeoutMs = DEFAULT_TIMEOUT_MS, baseUrl = OPENROUTER_BASE_URL) {
    this.apiKey = apiKey;
    this.model = model;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      } catch (error: unknown) {
        throw new Error(`Embedding generation failed: ${errorMessage(error)}`, { cause: error });
      }
      return openRouterEmbeddingsFromResponse(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.embedDocument(text);
  }

  async embedBatch(texts: readonly string[]): Promise<number[][]> {
    return this.request(texts.map((text) => openRouterInput(this.model, "passage", text)));
  }

  async embedQuery(text: string): Promise<number[]> {
    return (await this.request([openRouterInput(this.model, "query", text)]))[0] ?? [];
  }

  async embedDocument(text: string): Promise<number[]> {
    return (await this.request([openRouterInput(this.model, "passage", text)]))[0] ?? [];
  }

  async close(): Promise<void> {}
}

export function createEmbeddingService(
  config: Pick<VaultConfig, "embeddingProvider" | "embeddingModel" | "ollamaUrl" | "openrouterApiKey">,
  fetcher?: EmbeddingFetcher,
): EmbeddingClient {
  if (config.embeddingProvider === "openrouter") {
    if (config.openrouterApiKey === undefined) {
      throw new Error("openrouter_api_key must be set when using openrouter embedding provider");
    }
    return new OpenRouterEmbeddingService(config.openrouterApiKey, config.embeddingModel, fetcher);
  }
  return new EmbeddingService(config.ollamaUrl, config.embeddingModel, fetcher);
}
