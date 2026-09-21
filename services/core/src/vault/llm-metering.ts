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
    try {
      const response = await this.provider.generate(prompt, options);
      await this.recordUsage(prompt, response, Math.trunc(performance.now() - startedAt));
      return response;
    } catch (error: unknown) {
      // A provider failure still represents a metered attempt. Recording an
      // empty output keeps failed map/reduce units visible without hiding the
      // original error from the pipeline.
      await this.recordUsage(prompt, "", Math.trunc(performance.now() - startedAt));
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.provider.close();
  }

  private async recordUsage(prompt: string, response: string, durationMs: number): Promise<void> {
    const pricing = this.pricingService.getModelPricing(this.providerName, this.modelName);
    const snapshot = this.pricingService.getSnapshotMetadata();
    const inputTokens = Math.trunc(prompt.length / 4);
    const outputTokens = Math.trunc(response.length / 4);
    await this.writeUsageRecord({
      provider: this.providerName,
      model: this.modelName,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      input_price_per_million: pricing.input,
      output_price_per_million: pricing.output,
      estimated_cost: calculateEstimatedCost(inputTokens, outputTokens, pricing),
      context: this.contextPrefix,
      duration_ms: durationMs,
      pricing_snapshot_refreshed_at: snapshot.refreshed_at,
      created_at: "time::now()",
    });
  }

  private async writeUsageRecord(usage: MeteredLlmUsage): Promise<void> {
    try {
      await this.storage.record_llm_usage(usage);
    } catch {
      return;
    }
  }
}
