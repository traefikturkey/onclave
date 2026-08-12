import type { PricingSnapshotMetadata } from "./llm-pricing";

export type UsageQuery = {
  start_date?: Date;
  end_date?: Date;
  provider?: string;
  model?: string;
};

export type UsageBreakdownItem = {
  provider: string;
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost: number;
};

export type UsageResponse = {
  total_calls: number;
  total_input_tokens: number;
  total_output_tokens: number;
  estimated_total_cost: number;
  breakdown: UsageBreakdownItem[];
  pricing_snapshot: PricingSnapshotMetadata;
};

export type UsageStorage = {
  usage_totals(start?: Date, end?: Date, provider?: string, model?: string): Promise<Record<string, unknown>>;
  usage_breakdown(start?: Date, end?: Date, provider?: string, model?: string): Promise<Record<string, unknown>[]>;
};

export type UsagePricingService = {
  getSnapshotMetadata(): PricingSnapshotMetadata;
};

function integer(value: unknown): number {
  return Math.trunc(Number(value || 0));
}

function decimal(value: unknown): number {
  return Number(value || 0);
}

function text(value: unknown): string {
  return String(value || "");
}

function breakdownItem(item: Record<string, unknown>): UsageBreakdownItem {
  return {
    provider: text(item.provider),
    model: text(item.model),
    calls: integer(item.calls),
    input_tokens: integer(item.input_tokens),
    output_tokens: integer(item.output_tokens),
    estimated_cost: decimal(item.estimated_cost),
  };
}

export function toUsageQuery(start_date?: Date, end_date?: Date, provider?: string, model?: string): UsageQuery {
  return { start_date, end_date, provider, model };
}

export async function getUsage(storage: UsageStorage, pricingService: UsagePricingService, query: UsageQuery = {}): Promise<UsageResponse> {
  const totals = await storage.usage_totals(query.start_date, query.end_date, query.provider, query.model);
  const breakdown = await storage.usage_breakdown(query.start_date, query.end_date, query.provider, query.model);
  return {
    total_calls: integer(totals.total_calls),
    total_input_tokens: integer(totals.total_input_tokens),
    total_output_tokens: integer(totals.total_output_tokens),
    estimated_total_cost: decimal(totals.estimated_total_cost),
    breakdown: breakdown.map(breakdownItem),
    pricing_snapshot: pricingService.getSnapshotMetadata(),
  };
}
