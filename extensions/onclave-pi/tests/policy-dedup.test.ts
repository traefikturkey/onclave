import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SeenIds } from "../src/lib/dedup";
import {
  isAutoAccepted,
  isDelegatedAuthorityAgent,
  loadAdapterPolicy,
} from "../src/lib/policy";
import { lastAssistantText, runUsage } from "../src/lib/run-summary";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onclave-pi-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadAdapterPolicy", () => {
  it("returns empty policy when the file is missing or invalid", async () => {
    expect(await loadAdapterPolicy(join(dir, "missing.json"))).toEqual({
      autoAcceptHosts: [],
      delegatedAuthorityAgents: [],
    });
    const invalid = join(dir, "invalid.json");
    await writeFile(invalid, "{broken", "utf8");
    expect(await loadAdapterPolicy(invalid)).toEqual({
      autoAcceptHosts: [],
      delegatedAuthorityAgents: [],
    });
  });

  it("reloads changes without restart (fresh read per call)", async () => {
    const path = join(dir, "policy.json");
    await writeFile(path, JSON.stringify({ autoAcceptHosts: [] }), "utf8");
    expect(isAutoAccepted(await loadAdapterPolicy(path), "build-box")).toBe(false);
    await writeFile(
      path,
      JSON.stringify({
        autoAcceptHosts: ["build-box"],
        delegatedAuthorityAgents: ["trusted-agent"],
      }),
      "utf8"
    );
    const policy = await loadAdapterPolicy(path);
    expect(isAutoAccepted(policy, "build-box")).toBe(true);
    expect(isDelegatedAuthorityAgent(policy, "trusted-agent")).toBe(true);
  });
});

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
