// Exchange count is the hard stop; the token budget stays advisory until
// adapter-reported usage is proven trustworthy (see v2 plan risks).

export type BudgetLimits = {
  maxExchanges: number;
  maxTotalTokens: number;
};

export type BudgetUsage = {
  exchanges: number;
  totalTokens: number;
};

export type BudgetVerdict =
  | { ok: true; advisory?: "token_budget_exceeded" }
  | { ok: false; reason: "exchange_budget_exceeded" };

export const DEFAULT_BUDGET_LIMITS: BudgetLimits = {
  maxExchanges: 16,
  maxTotalTokens: 200000,
};

export function evaluateBudget(limits: BudgetLimits, usage: BudgetUsage): BudgetVerdict {
  if (usage.exchanges >= limits.maxExchanges) {
    return { ok: false, reason: "exchange_budget_exceeded" };
  }
  if (usage.totalTokens >= limits.maxTotalTokens) {
    return { ok: true, advisory: "token_budget_exceeded" };
  }
  return { ok: true };
}
