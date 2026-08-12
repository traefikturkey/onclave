import type { JsonObject } from "./models";

export type ModelPricing = {
  input: number;
  output: number;
};

export type PricingSnapshot = Record<string, Record<string, ModelPricing>>;

export type PricingSnapshotMetadata = {
  refreshed_at: Date | undefined;
  is_stale: boolean;
  age_seconds: number | undefined;
  source: string;
};

export type PricingSnapshotStorage = {
  get_pricing_snapshot(snapshotId: string): Promise<Record<string, unknown> | undefined>;
  upsert_pricing_snapshot(snapshotId: string, pricing: JsonObject, refreshedAt: Date, source: string): Promise<void>;
};

export const LLM_PRICING_SNAPSHOT_ID = "llm_pricing_snapshot:active";

export const BOOTSTRAP_LLM_PRICING: PricingSnapshot = {
  openai: {
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  },
  anthropic: {
    "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  },
  openrouter: {
    "openrouter/aurora-alpha": { input: 0.0, output: 0.0 },
    "openai/gpt-oss-120b:free": { input: 0.0, output: 0.0 },
    "deepseek/deepseek-r1-0528:free": { input: 0.0, output: 0.0 },
    "google/gemma-3-27b-it:free": { input: 0.0, output: 0.0 },
  },
  ollama: {
    default: { input: 0.0, output: 0.0 },
  },
};

function clonePricing(pricing: PricingSnapshot): PricingSnapshot {
  return Object.fromEntries(
    Object.entries(pricing).map(([provider, models]) => [
      provider,
      Object.fromEntries(Object.entries(models).map(([model, rates]) => [model, { ...rates }])),
    ]),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parsePricing(value: unknown): PricingSnapshot | undefined {
  const providers = asRecord(value);
  if (providers === undefined) return undefined;
  const parsed: PricingSnapshot = {};
  for (const [provider, rawModels] of Object.entries(providers)) {
    const models = asRecord(rawModels);
    if (models === undefined) return undefined;
    parsed[provider] = {};
    for (const [model, rawRates] of Object.entries(models)) {
      const rates = asRecord(rawRates);
      if (rates === undefined || typeof rates.input !== "number" || typeof rates.output !== "number") return undefined;
      parsed[provider][model] = { input: rates.input, output: rates.output };
    }
  }
  return parsed;
}

function coerceDate(value: unknown): Date | undefined {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value !== "string" || value === "") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function pricingAsJsonObject(pricing: PricingSnapshot): JsonObject {
  return pricing;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

export function calculateEstimatedCost(inputTokens: number, outputTokens: number, pricing: ModelPricing): number {
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export class LLMPricingService {
  readonly refreshIntervalSeconds: number;
  readonly staleAfterSeconds: number;
  private pricing: PricingSnapshot = {};
  private refreshedAt: Date | undefined;
  private source = "bootstrap";
  private scheduler: { controller: AbortController; task: Promise<void> } | undefined;

  constructor(
    private readonly storage: PricingSnapshotStorage,
    options: { refreshIntervalSeconds?: number; staleAfterSeconds?: number } = {},
  ) {
    this.refreshIntervalSeconds = options.refreshIntervalSeconds ?? 24 * 60 * 60;
    this.staleAfterSeconds = options.staleAfterSeconds ?? 7 * 24 * 60 * 60;
  }

  async initialize(): Promise<void> {
    const persisted = await this.loadPersistedSnapshot();
    if (persisted !== undefined) {
      this.applySnapshot(persisted);
      return;
    }
    const snapshot = this.buildLatestSnapshot();
    const refreshedAt = new Date();
    this.pricing = snapshot;
    this.refreshedAt = refreshedAt;
    this.source = "bootstrap";
    await this.persistSnapshot(snapshot, refreshedAt, this.source);
  }

  getModelPricing(provider: string, model: string): ModelPricing {
    const rates = this.pricing[provider]?.[model];
    return rates === undefined ? { input: 0.0, output: 0.0 } : { ...rates };
  }

  getSnapshotMetadata(now = new Date()): PricingSnapshotMetadata {
    if (this.refreshedAt === undefined) {
      return { refreshed_at: undefined, is_stale: true, age_seconds: undefined, source: this.source };
    }
    const ageSeconds = Math.trunc((now.getTime() - this.refreshedAt.getTime()) / 1000);
    return {
      refreshed_at: this.refreshedAt,
      is_stale: ageSeconds > this.staleAfterSeconds,
      age_seconds: ageSeconds,
      source: this.source,
    };
  }

  async refreshSnapshot(): Promise<void> {
    try {
      const snapshot = this.buildLatestSnapshot();
      const refreshedAt = new Date();
      this.pricing = snapshot;
      this.refreshedAt = refreshedAt;
      this.source = "bootstrap";
      await this.persistSnapshot(snapshot, refreshedAt, this.source);
    } catch {
      return;
    }
  }

  async startScheduler(): Promise<void> {
    if (this.scheduler !== undefined) return;
    const controller = new AbortController();
    const task = this.schedulerLoop(controller.signal);
    this.scheduler = { controller, task };
  }

  async stopScheduler(): Promise<void> {
    const scheduler = this.scheduler;
    if (scheduler === undefined) return;
    scheduler.controller.abort();
    await scheduler.task;
    this.scheduler = undefined;
  }

  private async schedulerLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      await wait(this.refreshIntervalSeconds * 1000, signal);
      if (!signal.aborted) await this.refreshSnapshot();
    }
  }

  private async loadPersistedSnapshot(): Promise<Record<string, unknown> | undefined> {
    const record = await this.storage.get_pricing_snapshot(LLM_PRICING_SNAPSHOT_ID);
    const pricing = record === undefined ? undefined : parsePricing(record.pricing);
    if (pricing === undefined || Object.keys(pricing).length === 0) return undefined;
    return record;
  }

  private applySnapshot(snapshot: Record<string, unknown>): void {
    this.pricing = parsePricing(snapshot.pricing) ?? {};
    this.refreshedAt = coerceDate(snapshot.refreshed_at);
    this.source = typeof snapshot.source === "string" && snapshot.source !== "" ? snapshot.source : "persisted";
  }

  private async persistSnapshot(snapshot: PricingSnapshot, refreshedAt: Date, source: string): Promise<void> {
    try {
      await this.storage.upsert_pricing_snapshot(LLM_PRICING_SNAPSHOT_ID, pricingAsJsonObject(snapshot), refreshedAt, source);
    } catch {
      return;
    }
  }

  private buildLatestSnapshot(): PricingSnapshot {
    return clonePricing(BOOTSTRAP_LLM_PRICING);
  }
}
