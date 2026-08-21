import { describe, expect, it } from "vitest";
import {
  AnthropicProvider,
  FallbackProvider,
  OllamaLLMProvider,
  OpenAIProvider,
  OpenRouterProvider,
  LlmProviderFailure,
  type LlmFetcher,
  type LlmProvider,
  type UsageReportingLlmProvider,
} from "../src/vault/llm-providers";
import { MeteringLLMProvider, type MeteredLlmUsage } from "../src/vault/llm-metering";
import {
  BOOTSTRAP_LLM_PRICING,
  calculateEstimatedCost,
  LLMPricingService,
  type PricingSnapshotStorage,
} from "../src/vault/llm-pricing";
import { getUsage, type UsageStorage } from "../src/vault/usage";

type FetchCall = { url: string; init: RequestInit | undefined };

function responseFetcher(body: unknown, calls: FetchCall[]): LlmFetcher {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
}

function requestBody(call: FetchCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("expected a JSON request body");
  const parsed: unknown = JSON.parse(call.init.body);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object request body");
  return parsed as Record<string, unknown>;
}

function requestHeaders(call: FetchCall): Record<string, string> {
  const headers = call.init?.headers;
  if (headers === undefined || Array.isArray(headers) || headers instanceof Headers) throw new Error("expected record headers");
  return headers as Record<string, string>;
}

class FakePricingStorage implements PricingSnapshotStorage {
  readonly writes: { snapshotId: string; pricing: Record<string, unknown>; refreshedAt: Date; source: string }[] = [];

  async get_pricing_snapshot(_snapshotId: string): Promise<Record<string, unknown> | undefined> {
    return undefined;
  }

  async upsert_pricing_snapshot(snapshotId: string, pricing: Record<string, unknown>, refreshedAt: Date, source: string): Promise<void> {
    this.writes.push({ snapshotId, pricing, refreshedAt, source });
  }
}

class FakeUsageStorage implements UsageStorage {
  calls: (readonly [Date | undefined, Date | undefined, string | undefined, string | undefined])[] = [];
  readonly records: MeteredLlmUsage[] = [];

  async record_llm_usage(usage: MeteredLlmUsage): Promise<void> {
    this.records.push(usage);
  }

  async usage_totals(start?: Date, end?: Date, provider?: string, model?: string): Promise<Record<string, unknown>> {
    this.calls.push([start, end, provider, model]);
    return {
      total_calls: "3",
      total_input_tokens: "100",
      total_output_tokens: "25",
      estimated_total_cost: "0.012",
    };
  }

  async usage_breakdown(start?: Date, end?: Date, provider?: string, model?: string): Promise<Record<string, unknown>[]> {
    this.calls.push([start, end, provider, model]);
    return [{
      provider: "openai",
      model: "gpt-4o-mini",
      calls: "3",
      input_tokens: "100",
      output_tokens: "25",
      estimated_cost: "0.012",
    }];
  }
}

describe("vault LLM providers", () => {
  it("shapes Ollama requests and parses text and token counts", async () => {
    const calls: FetchCall[] = [];
    const provider = new OllamaLLMProvider("http://ollama.local///", "llama3", responseFetcher({ response: "Ollama reply", prompt_eval_count: 7, eval_count: 3 }, calls));

    await expect(provider.generateWithUsage("prompt", { systemPrompt: "system", maxTokens: 12, temperature: 0.2, timeout: 5 })).resolves.toEqual({ text: "Ollama reply", inputTokens: 7, outputTokens: 3 });
    expect(calls[0]?.url).toBe("http://ollama.local/api/generate");
    expect(requestBody(calls[0] ?? { url: "", init: undefined })).toEqual({
      model: "llama3",
      prompt: "prompt",
      stream: false,
      options: { num_predict: 12, temperature: 0.2 },
      system: "system",
    });
  });

  it("shapes OpenAI requests and parses OpenAI usage", async () => {
    const calls: FetchCall[] = [];
    const provider = new OpenAIProvider("test-token", "gpt-4o-mini", responseFetcher({ choices: [{ message: { content: "OpenAI reply" } }], usage: { prompt_tokens: 8, completion_tokens: 4 } }, calls));

    await expect(provider.generateWithUsage("prompt", { systemPrompt: "system" })).resolves.toEqual({ text: "OpenAI reply", inputTokens: 8, outputTokens: 4 });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(requestHeaders(calls[0] ?? { url: "", init: undefined })).toEqual({ Authorization: "Bearer test-token", "Content-Type": "application/json" });
    expect(requestBody(calls[0] ?? { url: "", init: undefined })).toEqual({
      model: "gpt-4o-mini",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "prompt" }],
      max_tokens: 4096,
      temperature: 0.7,
    });
  });

  it("shapes Anthropic requests and parses Anthropic usage", async () => {
    const calls: FetchCall[] = [];
    const provider = new AnthropicProvider("test-token", "claude-3-5-haiku-20241022", responseFetcher({ content: [{ text: "Anthropic reply" }], usage: { input_tokens: 9, output_tokens: 5 } }, calls));

    await expect(provider.generateWithUsage("prompt", { systemPrompt: "system" })).resolves.toEqual({ text: "Anthropic reply", inputTokens: 9, outputTokens: 5 });
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requestHeaders(calls[0] ?? { url: "", init: undefined })).toEqual({ "x-api-key": "test-token", "anthropic-version": "2023-06-01", "Content-Type": "application/json" });
    expect(requestBody(calls[0] ?? { url: "", init: undefined })).toEqual({
      model: "claude-3-5-haiku-20241022",
      messages: [{ role: "user", content: "prompt" }],
      max_tokens: 4096,
      temperature: 0.7,
      system: "system",
    });
  });

  it.each([408, 425, 429, 500, 502, 503, 504])("retries every transient HTTP status: %s", async (status) => {
    let calls = 0;
    const provider = new OllamaLLMProvider("http://ollama.local", "model", async () => {
      calls += 1;
      return new Response("busy", { status });
    }, { delay: async () => {} });

    const error = await provider.generate("prompt").catch((value: unknown) => value);
    expect(error).toMatchObject({ classification: "transient", attempts: 3, status });
    expect(calls).toBe(3);
  });

  it("ignores Retry-After for non-429/503 transient responses", async () => {
    const delays: number[] = [];
    const provider = new OllamaLLMProvider("http://ollama.local", "model", async () => new Response("busy", {
      status: 500,
      headers: { "retry-after": "120" },
    }), { random: () => 0.5, maxDelayMs: 1500, delay: async (milliseconds) => { delays.push(milliseconds); } });

    await provider.generate("prompt").catch(() => undefined);
    expect(delays).toEqual([500, 750]);
  });

  it("retries transient HTTP failures three times with capped jitter and exposes typed exhaustion", async () => {
    const calls: FetchCall[] = [];
    const delays: number[] = [];
    const provider = new OllamaLLMProvider("http://ollama.local", "llama3", async (url, init) => {
      calls.push({ url, init });
      return new Response("busy", { status: 503, headers: { "retry-after": "120" } });
    }, { random: () => 0.5, maxDelayMs: 1500, delay: async (milliseconds) => { delays.push(milliseconds); } });

    const error = await provider.generate("prompt").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(LlmProviderFailure);
    expect(error).toMatchObject({ classification: "transient", attempts: 3, status: 503 });
    expect((error as LlmProviderFailure).lastError).toEqual(new Error("HTTP 503"));
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 1500]);
  });

  it("does not retry permanent HTTP failures or invalid successful responses", async () => {
    const permanent = new OpenAIProvider("token", "model", async () => new Response("no", { status: 400 }));
    const permanentError = await permanent.generate("prompt").catch((value: unknown) => value);
    expect(permanentError).toMatchObject({ classification: "permanent", attempts: 1, status: 400 });

    const invalid = new OllamaLLMProvider("http://ollama.local", "model", async () => new Response("{}", { status: 200 }));
    const invalidError = await invalid.generate("prompt").catch((value: unknown) => value);
    expect(invalidError).toMatchObject({ classification: "permanent", attempts: 1 });
  });

  it("rejects missing or non-string Ollama responses but preserves an empty string", async () => {
    for (const body of [{}, { response: 42 }]) {
      const provider = new OllamaLLMProvider("http://ollama.local", "model", async () => new Response(JSON.stringify(body), { status: 200 }));
      await expect(provider.generate("prompt")).rejects.toMatchObject({ classification: "permanent", attempts: 1 });
    }
    const empty = new OllamaLLMProvider("http://ollama.local", "model", async () => new Response(JSON.stringify({ response: "" }), { status: 200 }));
    await expect(empty.generate("prompt")).resolves.toBe("");
  });

  it("rethrows caller abort instead of falling back", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const first: UsageReportingLlmProvider = { model: "first", async generateWithUsage() { calls.push("first"); throw new Error("aborted"); }, async generate() { return ""; }, async close() {} };
    const second: UsageReportingLlmProvider = { model: "second", async generateWithUsage() { calls.push("second"); return { text: "fallback" }; }, async generate() { return "fallback"; }, async close() {} };
    controller.abort(new Error("caller stopped"));
    await expect(new FallbackProvider([["first", first], ["second", second]]).generate("prompt", { signal: controller.signal })).rejects.toEqual(new Error("caller stopped"));
    expect(calls).toEqual([]);
  });

  it("retries transport failures and propagates caller abort during backoff", async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider = new OllamaLLMProvider("http://ollama.local", "model", async () => {
      calls += 1;
      return new Response("busy", { status: 503 });
    }, { delay: () => new Promise<void>(() => {}) });
    const pending = provider.generate("prompt", { signal: controller.signal });
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toEqual(new Error("caller stopped"));
    expect(calls).toBe(1);
  });

  it("retries internal timeout and transport errors", async () => {
    let calls = 0;
    const provider = new OllamaLLMProvider("http://ollama.local", "model", async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => init?.signal?.addEventListener("abort", () => resolve(), { once: true }));
        throw new Error("request timed out");
      }
      return new Response(JSON.stringify({ response: "ok" }), { status: 200 });
    }, { delay: async () => {} });
    await expect(provider.generate("prompt", { timeout: 0.001 })).resolves.toBe("ok");
    expect(calls).toBe(2);

    const transport = new OllamaLLMProvider("http://ollama.local", "model", async () => {
      throw new Error("transport down");
    }, { delay: async () => {} });
    const error = await transport.generate("prompt").catch((value: unknown) => value);
    expect(error).toMatchObject({ classification: "transient", attempts: 3 });
  });

  it("shapes OpenRouter requests and parses OpenAI-compatible usage", async () => {
    const calls: FetchCall[] = [];
    const provider = new OpenRouterProvider("test-token", "openai/gpt-4o-mini", responseFetcher({ choices: [{ message: { content: "OpenRouter reply" } }], usage: { prompt_tokens: 10, completion_tokens: 6 } }, calls));

    await expect(provider.generateWithUsage("prompt")).resolves.toEqual({ text: "OpenRouter reply", inputTokens: 10, outputTokens: 6 });
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(requestHeaders(calls[0] ?? { url: "", init: undefined })).toEqual({ Authorization: "Bearer test-token", "HTTP-Referer": "menos", "Content-Type": "application/json" });
  });
});

describe("vault LLM pricing and metering", () => {
  it("uses the frozen per-million pricing rates without rounding", () => {
    const rates = BOOTSTRAP_LLM_PRICING.openai?.["gpt-4o-mini"];
    if (rates === undefined) throw new Error("missing OpenAI pricing fixture");
    expect(rates).toEqual({ input: 0.15, output: 0.6 });
    expect(calculateEstimatedCost(1_000_000, 1_000_000, rates)).toBe(0.75);
    expect(calculateEstimatedCost(1, 2, rates)).toBe(0.00000135);
  });

  it("records the Menos usage fields with character-based token estimates", async () => {
    const pricing = new LLMPricingService(new FakePricingStorage());
    await pricing.initialize();
    const storage = new FakeUsageStorage();
    const provider: LlmProvider = {
      model: "gpt-4o-mini",
      async generate(): Promise<string> { return "hello world"; },
      async close(): Promise<void> { return Promise.resolve(); },
    };
    const metered = new MeteringLLMProvider(provider, storage, "search:expansion", "openai", "gpt-4o-mini", pricing);

    await expect(metered.generate("abcd")).resolves.toBe("hello world");
    expect(storage.records).toHaveLength(1);
    expect(storage.records[0]).toMatchObject({
      provider: "openai",
      model: "gpt-4o-mini",
      input_tokens: 1,
      output_tokens: 2,
      input_price_per_million: 0.15,
      output_price_per_million: 0.6,
      estimated_cost: 0.00000135,
      context: "search:expansion",
      created_at: "time::now()",
    });
  });
});

describe("vault usage aggregation", () => {
  it("preserves usage totals, provider-model breakdown, filters, and pricing metadata", async () => {
    const storage = new FakeUsageStorage();
    const start = new Date("2026-01-01T00:00:00.000Z");
    const end = new Date("2026-01-31T00:00:00.000Z");
    const pricingSnapshot = { refreshed_at: new Date("2026-01-01T00:00:00.000Z"), is_stale: false, age_seconds: 0, source: "bootstrap" };

    await expect(getUsage(storage, { getSnapshotMetadata: () => pricingSnapshot }, { start_date: start, end_date: end, provider: "openai", model: "gpt-4o-mini" })).resolves.toEqual({
      total_calls: 3,
      total_input_tokens: 100,
      total_output_tokens: 25,
      estimated_total_cost: 0.012,
      breakdown: [{ provider: "openai", model: "gpt-4o-mini", calls: 3, input_tokens: 100, output_tokens: 25, estimated_cost: 0.012 }],
      pricing_snapshot: pricingSnapshot,
    });
    expect(storage.calls).toEqual([
      [start, end, "openai", "gpt-4o-mini"],
      [start, end, "openai", "gpt-4o-mini"],
    ]);
  });
});
