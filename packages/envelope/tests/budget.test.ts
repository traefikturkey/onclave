import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGET_LIMITS, evaluateBudget } from "../src/budget";

describe("evaluateBudget", () => {
  const limits = { maxExchanges: 4, maxTotalTokens: 1000 };

  it("passes under both limits", () => {
    expect(evaluateBudget(limits, { exchanges: 3, totalTokens: 999 })).toEqual({ ok: true });
  });

  it("hard-stops at the exchange budget", () => {
    expect(evaluateBudget(limits, { exchanges: 4, totalTokens: 0 })).toEqual({
      ok: false,
      reason: "exchange_budget_exceeded",
    });
  });

  it("treats the token budget as advisory", () => {
    expect(evaluateBudget(limits, { exchanges: 0, totalTokens: 1000 })).toEqual({
      ok: true,
      advisory: "token_budget_exceeded",
    });
  });

  it("prefers the hard stop when both are exceeded", () => {
    expect(evaluateBudget(limits, { exchanges: 10, totalTokens: 5000 })).toEqual({
      ok: false,
      reason: "exchange_budget_exceeded",
    });
  });

  it("ships sane defaults", () => {
    expect(DEFAULT_BUDGET_LIMITS.maxExchanges).toBeGreaterThan(0);
    expect(DEFAULT_BUDGET_LIMITS.maxTotalTokens).toBeGreaterThan(0);
  });
});
