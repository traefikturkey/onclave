import { describe, expect, it } from "vitest";
import { SeenIds } from "../src/lib/dedup";
import { lastAssistantText, runUsage } from "../src/lib/run-summary";

describe("SeenIds", () => {
  it("reports duplicates and bounds memory", () => {
    const seen = new SeenIds(3);
    expect(seen.add("a")).toBe(true);
    expect(seen.add("a")).toBe(false);
    seen.add("b");
    seen.add("c");
    seen.add("d");
    expect(seen.has("a")).toBe(false);
    expect(seen.has("d")).toBe(true);
  });
});

describe("run summary helpers", () => {
  const messages = [
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: [{ type: "text", text: "thinking about it" }],
      usage: { input: 10, output: 5 },
    },
    { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hmm" },
        { type: "text", text: "final answer" },
      ],
      usage: { input: 20, output: 7 },
    },
  ];

  it("extracts the last assistant text", () => {
    expect(lastAssistantText(messages)).toBe("final answer");
    expect(lastAssistantText([{ role: "user" }])).toBe("");
  });

  it("sums usage across assistant messages", () => {
    expect(runUsage(messages)).toEqual({ input_tokens: 30, output_tokens: 12 });
  });
});
