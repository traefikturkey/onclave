import type { LlmProvider } from "./llm-providers";
import { calculateEstimatedCost, type LLMPricingService } from "./llm-pricing";

export type MeteredLlmUsage = {
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  input_price_per_million: number;
  output_price_per_million: number;
  estimated_cost: number;
  context: string;
  duration_ms: number;
  pricing_snapshot_refreshed_at?: Date;
  created_at: "time::now()";
};

export type LlmUsageStorage = {
  record_llm_usage(usage: MeteredLlmUsage): Promise<void>;
};

export class MeteringLLMProvider implements LlmProvider {
  readonly model: string;

  constructor(
    private readonly provider: LlmProvider,
    private readonly storage: LlmUsageStorage,
    private readonly contextPrefix: string,
    private readonly providerName: string,
    private readonly modelName: string,
    private readonly pricingService: LLMPricingService,
  ) {
    this.model = provider.model;
  }

  withContext(context: string): MeteringLLMProvider {
    return new MeteringLLMProvider(
      this.provider,
      this.storage,
      context,
      this.providerName,
      this.modelName,
      this.pricingService,
    );
  }

  async generate(prompt: string, options: Parameters<LlmProvider["generate"]>[1] = {}): Promise<string> {
    const startedAt = performance.now();
    const response = await this.provider.generate(prompt, options);
    const durationMs = Math.trunc(performance.now() - startedAt);
    const pricing = this.pricingService.getModelPricing(this.providerName, this.modelName);
    const snapshot = this.pricingService.getSnapshotMetadata();
    const usage: MeteredLlmUsage = {
      provider: this.providerName,
      model: this.modelName,
      input_tokens: Math.trunc(prompt.length / 4),
      output_tokens: Math.trunc(response.length / 4),
      input_price_per_million: pricing.input,
      output_price_per_million: pricing.output,
      estimated_cost: calculateEstimatedCost(Math.trunc(prompt.length / 4), Math.trunc(response.length / 4), pricing),
      context: this.contextPrefix,
      duration_ms: durationMs,
      pricing_snapshot_refreshed_at: snapshot.refreshed_at,
      created_at: "time::now()",
    };
    void this.writeUsageRecord(usage);
    await Promise.resolve();
    return response;
  }

  async close(): Promise<void> {
    await this.provider.close();
  }

  private async writeUsageRecord(usage: MeteredLlmUsage): Promise<void> {
    try {
      await this.storage.record_llm_usage(usage);
    } catch {
      return;
    }
  }
}
