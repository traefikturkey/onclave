import { describe, expect, it } from "vitest";
import {
  AnalysisBudgetError,
  DEFAULT_ANALYSIS_INPUT_BUDGET_TOKENS,
  DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS,
  estimateAnalysisTokens,
  planAdjacentReduction,
  planAnalysisChunks,
} from "../src/vault/analysis-budget";

const segment = (source_segment_id: string, text: string) => ({ source_segment_id, text });

describe("analysis budget planning", () => {
  it("keeps a short complete transcript in one ordered unit", () => {
    const plan = planAnalysisChunks([
      segment("one", "Opening claim."),
      segment("two", "A demonstrated result."),
      segment("three", "A limitation."),
    ], { budgetTokens: 100, outputReservationTokens: 20, promptOverheadTokens: 10 });

    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]?.segments.map(({ source_segment_id }) => source_segment_id)).toEqual(["one", "two", "three"]);
    expect(plan.chunks[0]?.text).toBe("Opening claim.\n\nA demonstrated result.\n\nA limitation.");
    expect(plan.complete).toBe(true);
  });

  it("accounts for prompt overhead and output reservation", () => {
    const plan = planAnalysisChunks([segment("one", "1234567890")], {
      budgetTokens: 10,
      outputReservationTokens: 3,
      promptOverheadTokens: 4,
    });
    expect(plan.chunks[0]?.estimatedSourceTokens).toBe(3);
    expect(plan.chunks[0]?.estimatedTotalTokens).toBe(10);
    const split = planAnalysisChunks([segment("one", "1234567890123")], {
      budgetTokens: 10,
      outputReservationTokens: 3,
      promptOverheadTokens: 4,
    });
    expect(split.chunks).toHaveLength(2);
  });

  it("splits oversized captions without dropping non-ASCII text or its source reference", () => {
    const text = "前".repeat(7) + "🙂" + "tail";
    const plan = planAnalysisChunks([segment("caption-1", text), segment("caption-2", "last")], {
      budgetTokens: 10,
      outputReservationTokens: 2,
      promptOverheadTokens: 2,
    });
    const pieces = plan.chunks.flatMap((chunk) => chunk.segments.filter(({ source_segment_id }) => source_segment_id === "caption-1").map(({ text: piece }) => piece));
    expect(pieces.join("")).toBe(text);
    expect(new Set(plan.chunks.flatMap((chunk) => chunk.segments.map(({ source_segment_id }) => source_segment_id)))).toEqual(new Set(["caption-1", "caption-2"]));
    expect(plan.source_piece_count).toBeGreaterThan(2);
    expect(plan.chunks.every((chunk) => chunk.estimatedTotalTokens <= 10)).toBe(true);
  });

  it("rejects invalid and insufficient budgets with the actual accounting", () => {
    expect(() => planAnalysisChunks([], { budgetTokens: 0 })).toThrow(AnalysisBudgetError);
    expect(() => planAnalysisChunks([], { budgetTokens: 3, outputReservationTokens: 2, promptOverheadTokens: 1 })).toThrow(
      "3 tokens minus 1 prompt-overhead tokens and 2 output-reservation tokens leaves 0 source tokens",
    );
    expect(() => planAnalysisChunks([], { budgetTokens: 10, outputReservationTokens: -1 })).toThrow("output reservation must be a positive integer");
  });

  it("documents stable conservative defaults and handles non-ASCII estimates", () => {
    expect(DEFAULT_ANALYSIS_INPUT_BUDGET_TOKENS).toBe(12_000);
    expect(DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS).toBe(3_000);
    expect(estimateAnalysisTokens("abcd")).toBe(1);
    expect(estimateAnalysisTokens("前🙂")).toBe(2);
  });
});

describe("adjacent analysis reduction planning", () => {
  it("reduces adjacent groups recursively and preserves source order", () => {
    const plan = planAdjacentReduction([
      { text: "a".repeat(20), source_segment_ids: ["a"] },
      { text: "b".repeat(20), source_segment_ids: ["b"] },
      { text: "c".repeat(20), source_segment_ids: ["c"] },
      { text: "d".repeat(20), source_segment_ids: ["d"] },
      { text: "e".repeat(20), source_segment_ids: ["e"] },
      { text: "f".repeat(20), source_segment_ids: ["f"] },
    ], { budgetTokens: 20, outputReservationTokens: 5, promptOverheadTokens: 2 });

    expect(plan.levels.length).toBeGreaterThan(1);
    expect(plan.levels[0]?.batches.map((batch) => batch.source_segment_ids)).toEqual([["a", "b"], ["c", "d"], ["e", "f"]]);
    expect(plan.final_note_count).toBe(2);
  });

  it("detects a non-progressing reduction instead of looping", () => {
    expect(() => planAdjacentReduction([
      { text: "a".repeat(20), source_segment_ids: ["a"] },
      { text: "b".repeat(20), source_segment_ids: ["b"] },
    ], { budgetTokens: 12, outputReservationTokens: 5, promptOverheadTokens: 2 })).toThrow("cannot make progress");
  });
});
