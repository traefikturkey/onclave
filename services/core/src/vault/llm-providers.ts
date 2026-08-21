import type { LlmProviderType, VaultConfig } from "./config";

export type LlmGenerationOptions = {
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  signal?: AbortSignal;
};

export type LlmGeneration = {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
};

export type LlmProvider = {
  readonly model: string;
  generate(prompt: string, options?: LlmGenerationOptions): Promise<string>;
  close(): Promise<void>;
};

export type UsageReportingLlmProvider = LlmProvider & {
  generateWithUsage(prompt: string, options?: LlmGenerationOptions): Promise<LlmGeneration>;
};

export type LlmFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type LlmProviderPurpose = "expansion" | "synthesis" | "unifiedPipeline";

export type LlmFailureClassification = "transient" | "permanent";

export class LlmProviderFailure extends Error {
  readonly classification: LlmFailureClassification;
  readonly attempts: number;
  readonly status?: number;
  readonly lastError: unknown;

  constructor(message: string, details: { classification: LlmFailureClassification; attempts: number; status?: number; lastError: unknown }) {
    super(message, { cause: details.lastError });
    this.name = "LlmProviderFailure";
    this.classification = details.classification;
    this.attempts = details.attempts;
    this.status = details.status;
    this.lastError = details.lastError;
  }
}

export type LlmRetryOptions = {
  delay?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxDelayMs?: number;
};

type JsonRecord = Record<string, unknown>;
type ProviderRequest = {
  path: string;
  payload: JsonRecord;
  headers: Record<string, string>;
};

type NormalizedLlmGenerationOptions = {
  systemPrompt: string | undefined;
  maxTokens: number;
  temperature: number;
  timeout: number;
  signal: AbortSignal | undefined;
};

const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_TIMEOUT_SECONDS = 60;
const MAX_ATTEMPTS = 3;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function asRecord(value: unknown, provider: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${provider} returned an invalid response`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, provider: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${provider} returned an invalid response`);
  return value;
}

function requiredText(value: unknown, provider: string): string {
  if (typeof value !== "string") throw new Error(`${provider} returned an invalid response`);
  return value;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseRetryAfter(value: string): number | undefined {
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : Math.max(0, timestamp - Date.now());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generationOptions(options: LlmGenerationOptions): NormalizedLlmGenerationOptions {
  return {
    systemPrompt: options.systemPrompt ?? undefined,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
    timeout: options.timeout ?? DEFAULT_TIMEOUT_SECONDS,
    signal: options.signal,
  };
}

abstract class FetchLlmProvider implements UsageReportingLlmProvider {
  abstract readonly model: string;
  private readonly baseUrl: string;
  private readonly fetcher: LlmFetcher;
  private readonly retryOptions: Required<LlmRetryOptions>;

  protected constructor(baseUrl: string, fetcher: LlmFetcher, retryOptions: LlmRetryOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher;
    this.retryOptions = {
      delay: retryOptions.delay ?? delay,
      random: retryOptions.random ?? Math.random,
      maxDelayMs: retryOptions.maxDelayMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
  }

  protected abstract request(prompt: string, options: NormalizedLlmGenerationOptions): ProviderRequest;
  protected abstract parse(data: unknown): LlmGeneration;
  protected abstract readonly failurePrefix: string;

  async generate(prompt: string, options: LlmGenerationOptions = {}): Promise<string> {
    return (await this.generateWithUsage(prompt, options)).text;
  }

  async generateWithUsage(prompt: string, options: LlmGenerationOptions = {}): Promise<LlmGeneration> {
    const request = this.request(prompt, generationOptions(options));
    const normalized = generationOptions(options);
    const response = await this.post(request, normalized.timeout, normalized.signal);
    try {
      return this.parse(await response.json());
    } catch (error: unknown) {
      throw new LlmProviderFailure(`${this.failurePrefix} returned an invalid response`, { classification: "permanent", attempts: 1, lastError: error });
    }
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }

  private async post(request: ProviderRequest, timeoutSeconds: number, callerSignal?: AbortSignal): Promise<Response> {
    let lastError: unknown;
    let lastStatus: number | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
      const abortCaller = () => controller.abort(callerSignal?.reason);
      callerSignal?.addEventListener("abort", abortCaller, { once: true });
      try {
        const response = await this.fetcher(`${this.baseUrl}${request.path}`, { method: "POST", headers: request.headers, body: JSON.stringify(request.payload), signal: controller.signal });
        if (response.ok) return response;
        lastStatus = response.status;
        if (![408, 425, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new LlmProviderFailure(`${this.failurePrefix} failed: HTTP ${response.status}`, { classification: "permanent", attempts: attempt, status: response.status, lastError: new Error(`HTTP ${response.status}`) });
        }
        lastError = new Error(`HTTP ${response.status}`);
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = response.headers.get("retry-after");
          const retryMs = retryAfter && (response.status === 429 || response.status === 503) ? parseRetryAfter(retryAfter) : undefined;
          await this.waitBeforeRetry(attempt, retryMs, callerSignal);
        }
      } catch (error: unknown) {
        if (callerSignal?.aborted) throw callerSignal.reason;
        if (error instanceof LlmProviderFailure) throw error;
        lastError = error;
        if (attempt < MAX_ATTEMPTS) await this.waitBeforeRetry(attempt, undefined, callerSignal);
      } finally {
        clearTimeout(timeout);
        callerSignal?.removeEventListener("abort", abortCaller);
      }
    }
    throw new LlmProviderFailure(`${this.failurePrefix} exhausted after ${MAX_ATTEMPTS} attempts: ${errorMessage(lastError)}`, { classification: "transient", attempts: MAX_ATTEMPTS, status: lastStatus, lastError });
  }

  private async waitBeforeRetry(attempt: number, retryAfter: number | undefined, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw signal.reason;
    const cap = Math.min(this.retryOptions.maxDelayMs, 1000 * (2 ** (attempt - 1)));
    const requestedDelay = retryAfter ?? this.retryOptions.random() * cap;
    const milliseconds = Math.min(cap, Math.max(0, requestedDelay));
    const wait = this.retryOptions.delay(milliseconds);
    if (signal === undefined) {
      await wait;
      return;
    }
    await Promise.race([
      wait,
      new Promise<void>((_, reject) => {
        const abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        wait.finally(() => signal.removeEventListener("abort", abort)).catch(() => undefined);
      }),
    ]);
  }
}

export class OllamaLLMProvider extends FetchLlmProvider {
  readonly model: string;
  protected readonly failurePrefix = "LLM generation";

  constructor(baseUrl: string, model: string, fetcher: LlmFetcher = defaultFetcher, retryOptions?: LlmRetryOptions) {
    super(baseUrl, fetcher, retryOptions);
    this.model = model;
  }

  protected request(prompt: string, options: NormalizedLlmGenerationOptions): ProviderRequest {
    const payload: JsonRecord = {
      model: this.model,
      prompt,
      stream: false,
      options: {
        num_predict: options.maxTokens,
        temperature: options.temperature,
      },
    };
    if (options.systemPrompt !== undefined) payload.system = options.systemPrompt;
    return { path: "/api/generate", payload, headers: { "content-type": "application/json" } };
  }

  protected parse(data: unknown): LlmGeneration {
    const response = asRecord(data, "Ollama");
    const text = requiredText(response.response, "Ollama");
    return {
      text,
      inputTokens: tokenCount(response.prompt_eval_count),
      outputTokens: tokenCount(response.eval_count),
    };
  }
}

abstract class OpenAiCompatibleProvider extends FetchLlmProvider {
  protected request(prompt: string, options: NormalizedLlmGenerationOptions): ProviderRequest {
    const messages: JsonRecord[] = [];
    if (options.systemPrompt !== undefined) messages.push({ role: "system", content: options.systemPrompt });
    messages.push({ role: "user", content: prompt });
    return {
      path: "/chat/completions",
      payload: {
        model: this.model,
        messages,
        max_tokens: options.maxTokens,
        temperature: options.temperature,
      },
      headers: this.headers(),
    };
  }

  protected parse(data: unknown): LlmGeneration {
    const response = asRecord(data, this.failurePrefix);
    const firstChoice = asRecord(asArray(response.choices, this.failurePrefix)[0], this.failurePrefix);
    const message = asRecord(firstChoice.message, this.failurePrefix);
    const usage = response.usage === undefined ? undefined : asRecord(response.usage, this.failurePrefix);
    return {
      text: requiredText(message.content, this.failurePrefix),
      inputTokens: usage === undefined ? undefined : tokenCount(usage.prompt_tokens),
      outputTokens: usage === undefined ? undefined : tokenCount(usage.completion_tokens),
    };
  }

  protected abstract headers(): Record<string, string>;
}

export class OpenAIProvider extends OpenAiCompatibleProvider {
  readonly model: string;
  readonly apiKey: string;
  protected readonly failurePrefix = "OpenAI generation";

  constructor(apiKey: string, model = "gpt-4o-mini", fetcher: LlmFetcher = defaultFetcher, retryOptions?: LlmRetryOptions) {
    super("https://api.openai.com/v1", fetcher, retryOptions);
    this.apiKey = apiKey;
    this.model = model;
  }

  protected headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
  }
}

export class AnthropicProvider extends FetchLlmProvider {
  readonly model: string;
  readonly apiKey: string;
  protected readonly failurePrefix = "Anthropic generation";

  constructor(apiKey: string, model = "claude-3-5-haiku-20241022", fetcher: LlmFetcher = defaultFetcher, retryOptions?: LlmRetryOptions) {
    super("https://api.anthropic.com/v1", fetcher, retryOptions);
    this.apiKey = apiKey;
    this.model = model;
  }

  protected request(prompt: string, options: NormalizedLlmGenerationOptions): ProviderRequest {
    const payload: JsonRecord = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens,
      temperature: options.temperature,
    };
    if (options.systemPrompt !== undefined) payload.system = options.systemPrompt;
    return {
      path: "/messages",
      payload,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
    };
  }

  protected parse(data: unknown): LlmGeneration {
    const response = asRecord(data, "Anthropic");
    const firstContent = asRecord(asArray(response.content, "Anthropic")[0], "Anthropic");
    const usage = response.usage === undefined ? undefined : asRecord(response.usage, "Anthropic");
    return {
      text: requiredText(firstContent.text, "Anthropic"),
      inputTokens: usage === undefined ? undefined : tokenCount(usage.input_tokens),
      outputTokens: usage === undefined ? undefined : tokenCount(usage.output_tokens),
    };
  }
}

export class OpenRouterProvider extends OpenAiCompatibleProvider {
  readonly model: string;
  readonly apiKey: string;
  protected readonly failurePrefix = "OpenRouter generation";

  constructor(apiKey: string, model = "openai/gpt-4o-mini", fetcher: LlmFetcher = defaultFetcher, retryOptions?: LlmRetryOptions) {
    super("https://openrouter.ai/api/v1", fetcher, retryOptions);
    this.apiKey = apiKey;
    this.model = model;
  }

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "menos",
      "Content-Type": "application/json",
    };
  }
}

export class NoOpLLMProvider implements UsageReportingLlmProvider {
  readonly apiKey: string;
  readonly model: string;

  constructor(apiKey = "", model = "noop") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async generate(_prompt: string, _options: LlmGenerationOptions = {}): Promise<string> {
    return "";
  }

  async generateWithUsage(_prompt: string, _options: LlmGenerationOptions = {}): Promise<LlmGeneration> {
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

export class FallbackProvider implements UsageReportingLlmProvider {
  readonly providers: readonly (readonly [string, UsageReportingLlmProvider])[];
  readonly model: string;

  constructor(providers: readonly (readonly [string, UsageReportingLlmProvider])[]) {
    if (providers.length === 0) throw new Error("FallbackProvider requires at least one provider");
    this.providers = providers;
    this.model = providers[0]?.[1].model ?? "unknown";
  }

  async generate(prompt: string, options: LlmGenerationOptions = {}): Promise<string> {
    return (await this.generateWithUsage(prompt, options)).text;
  }

  async generateWithUsage(prompt: string, options: LlmGenerationOptions = {}): Promise<LlmGeneration> {
    const errors: string[] = [];
    for (const [name, provider] of this.providers) {
      if (options.signal?.aborted) throw options.signal.reason;
      try {
        const result = await provider.generateWithUsage(prompt, options);
        if (result.text.trim() === "") {
          errors.push(`${name}: Error: Empty response`);
          continue;
        }
        return result;
      } catch (error: unknown) {
        if (options.signal?.aborted) throw options.signal.reason;
        errors.push(`${name}: ${errorMessage(error)}`);
      }
    }
    throw new Error(`All providers failed: ${errors.join("; ")}`);
  }

  async close(): Promise<void> {
    await Promise.all(this.providers.map(([, provider]) => provider.close()));
  }
}

export function providerName(provider: LlmProvider): string {
  if (provider instanceof OpenAIProvider) return "openai";
  if (provider instanceof AnthropicProvider) return "anthropic";
  if (provider instanceof OpenRouterProvider) return "openrouter";
  if (provider instanceof OllamaLLMProvider) return "ollama";
  return provider.constructor.name.toLowerCase();
}

export function buildOpenRouterChain(apiKey: string, model = "", fetcher: LlmFetcher = defaultFetcher): UsageReportingLlmProvider {
  if (apiKey === "") throw new Error("openrouter_api_key must be set for openrouter provider");
  if (model !== "") return new OpenRouterProvider(apiKey, model, fetcher);
  return new FallbackProvider([
    ["aurora", new OpenRouterProvider(apiKey, "openrouter/aurora-alpha", fetcher)],
    ["gpt-oss", new OpenRouterProvider(apiKey, "openai/gpt-oss-120b:free", fetcher)],
    ["deepseek", new OpenRouterProvider(apiKey, "deepseek/deepseek-r1-0528:free", fetcher)],
    ["gemma3", new OpenRouterProvider(apiKey, "google/gemma-3-27b-it:free", fetcher)],
  ]);
}

export function createLlmProvider(config: VaultConfig, provider: LlmProviderType, model: string, fetcher: LlmFetcher = defaultFetcher): UsageReportingLlmProvider {
  if (provider === "ollama") return new OllamaLLMProvider(config.ollamaUrl, model, fetcher);
  if (provider === "openai") {
    if (config.openaiApiKey === undefined) throw new Error("openai_api_key must be set when using openai provider");
    return new OpenAIProvider(config.openaiApiKey, model, fetcher);
  }
  if (provider === "anthropic") {
    if (config.anthropicApiKey === undefined) throw new Error("anthropic_api_key must be set when using anthropic provider");
    return new AnthropicProvider(config.anthropicApiKey, model, fetcher);
  }
  if (provider === "openrouter") return buildOpenRouterChain(config.openrouterApiKey ?? "", model, fetcher);
  return new NoOpLLMProvider();
}

export function createConfiguredLlmProvider(config: VaultConfig, purpose: LlmProviderPurpose, fetcher: LlmFetcher = defaultFetcher): UsageReportingLlmProvider {
  if (purpose === "expansion") return createLlmProvider(config, config.agentExpansionProvider, config.agentExpansionModel, fetcher);
  if (purpose === "synthesis") return createLlmProvider(config, config.agentSynthesisProvider, config.agentSynthesisModel, fetcher);
  return createLlmProvider(config, config.unifiedPipelineProvider, config.unifiedPipelineModel, fetcher);
}
