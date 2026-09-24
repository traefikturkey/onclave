import { describe, expect, it, vi } from "vitest";
import type { VaultConfig } from "../src/vault/config";
import {
  configuredReadinessChecks,
  readinessResult,
  type ReadinessFetcher,
  type VaultReadinessChecks,
} from "../src/vault/readiness";

function vaultConfig(overrides: Partial<VaultConfig> = {}): VaultConfig {
  return {
    apiBaseUrl: "http://localhost:8000",
    appVersion: "test",
    postgresHost: "postgres",
    postgresPort: 5432,
    postgresUser: "menos",
    postgresPassword: "postgres-secret",
    postgresDatabase: "menos",
    postgresPoolMinSize: 1,
    postgresPoolMaxSize: 2,
    s3EndpointUrl: "http://minio:9000",
    s3AccessKey: "access",
    s3SecretKey: "s3-secret",
    s3Secure: false,
    s3Bucket: "menos",
    s3Region: "us-east-1",
    ollamaUrl: "http://ollama:11434",
    ollamaModel: "embed",
    embeddingProvider: "ollama",
    embeddingModel: "embed",
    doclingUrl: "http://docling:5001",
    sshPublicKeysPath: "/keys/authorized_keys",
    webshareProxyUsername: "proxy-user",
    webshareProxyPassword: "proxy-secret",
    agentExpansionProvider: "none",
    agentExpansionModel: "",
    agentRerankProvider: "none",
    agentRerankModel: "",
    agentSynthesisProvider: "none",
    agentSynthesisModel: "",
    unifiedPipelineEnabled: false,
    unifiedPipelineProvider: "none",
    unifiedPipelineModel: "",
    unifiedPipelineMaxConcurrency: 1,
    unifiedPipelineInputBudget: 12_000,
    unifiedPipelineMaxNewTags: 3,
    jobRecoveryBatchSize: 50,
    jobLeaseMs: 300_000,
    deliveryPollIntervalMs: 1_000,
    deliveryLeaseMs: 300_000,
    deliveryRetryBaseMs: 1_000,
    deliveryRetryMaxMs: 900_000,
    deliveryBatchSize: 50,
    entityMaxTopicsPerContent: 7,
    entityMinConfidence: 0.6,
    entityFetchExternalMetadata: true,
    ...overrides,
  };
}

function dependencies(bucketExists = true): {
  pool: { query(config: { text: string; query_timeout: number }): Promise<unknown> };
  storage: { bucket: string; client: { bucketExists(bucket: string): Promise<boolean> } };
} {
  return {
    pool: { query: async () => ({ rows: [{ "?column?": 1 }] }) },
    storage: { bucket: "menos", client: { bucketExists: async () => bucketExists } },
  };
}

describe("vault configured-dependency readiness", () => {
  it("checks only the selected embedding provider when the pipeline is disabled", async () => {
    const calls: { url: string; authorization: string | undefined }[] = [];
    const fetcher: ReadinessFetcher = async (url, init) => {
      const headers = new Headers(init?.headers);
      calls.push({ url, authorization: headers.get("authorization") ?? undefined });
      return new Response("{}", { status: 200 });
    };
    const config = vaultConfig({
      embeddingProvider: "openrouter",
      openrouterApiKey: "openrouter-secret",
      agentRerankProvider: "llm",
      unifiedPipelineEnabled: false,
      unifiedPipelineProvider: "ollama",
    });
    const deps = dependencies();

    await expect(readinessResult(config, configuredReadinessChecks(deps.pool, deps.storage, config, { fetcher }))).resolves.toEqual({
      status: "ready",
      checks: { postgres: "ok", s3: "ok", ollama: "skipped", openrouter: "ok" },
    });
    expect(calls).toEqual([{
      url: "https://openrouter.ai/api/v1/auth/key",
      authorization: "Bearer openrouter-secret",
    }]);
  });

  it("degrades for a missing credential required by an enabled pipeline without probing it", async () => {
    const calls: string[] = [];
    const fetcher: ReadinessFetcher = async (url) => {
      calls.push(url);
      return new Response("{}", { status: 200 });
    };
    const config = vaultConfig({
      embeddingProvider: "ollama",
      unifiedPipelineEnabled: true,
      unifiedPipelineProvider: "openrouter",
      openrouterApiKey: undefined,
    });
    const deps = dependencies();

    await expect(readinessResult(config, configuredReadinessChecks(deps.pool, deps.storage, config, { fetcher }))).resolves.toEqual({
      status: "degraded",
      checks: { postgres: "ok", s3: "ok", ollama: "ok", openrouter: "error:missing_credential" },
    });
    expect(calls).toEqual(["http://ollama:11434/api/tags"]);
  });

  it("treats a missing S3 bucket as unavailable", async () => {
    const config = vaultConfig();
    const deps = dependencies(false);
    const fetcher: ReadinessFetcher = async () => new Response("{}", { status: 200 });

    await expect(readinessResult(config, configuredReadinessChecks(deps.pool, deps.storage, config, { fetcher }))).resolves.toEqual({
      status: "degraded",
      checks: { postgres: "ok", s3: "error:unavailable", ollama: "ok" },
    });
  });

  it("bounds checks and never exposes dependency error details", async () => {
    vi.useFakeTimers();
    try {
      const secret = "https://operator:credential@example.invalid/signed?token=secret";
      const checks: VaultReadinessChecks = {
        postgres: async () => { throw new Error(secret); },
        s3: () => new Promise<void>(() => {}),
        ollama: async () => {},
      };
      const pending = readinessResult(vaultConfig(), checks);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(result).toEqual({
        status: "degraded",
        checks: { postgres: "error:unavailable", s3: "error:timeout", ollama: "ok" },
      });
      expect(JSON.stringify(result)).not.toContain("operator");
      expect(JSON.stringify(result)).not.toContain("credential");
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces and briefly caches a failing cloud probe, then retries after expiry", async () => {
    let now = 1_000;
    let fetchCalls = 0;
    let completeFirst: ((response: Response) => void) | undefined;
    const firstResponse = new Promise<Response>((resolve) => { completeFirst = resolve; });
    const fetcher: ReadinessFetcher = async () => {
      fetchCalls += 1;
      return fetchCalls === 1 ? firstResponse : new Response("unavailable", { status: 503 });
    };
    const config = vaultConfig({ embeddingProvider: "openrouter", openrouterApiKey: "key" });
    const deps = dependencies();
    const checks = configuredReadinessChecks(deps.pool, deps.storage, config, { fetcher, now: () => now });

    const first = readinessResult(config, checks);
    const concurrent = readinessResult(config, checks);
    await vi.waitFor(() => expect(fetchCalls).toBe(1));
    completeFirst?.(new Response("unavailable", { status: 503 }));
    await expect(Promise.all([first, concurrent])).resolves.toEqual([
      { status: "degraded", checks: { postgres: "ok", s3: "ok", ollama: "skipped", openrouter: "error:unavailable" } },
      { status: "degraded", checks: { postgres: "ok", s3: "ok", ollama: "skipped", openrouter: "error:unavailable" } },
    ]);

    now = 5_999;
    await readinessResult(config, checks);
    expect(fetchCalls).toBe(1);

    now = 6_000;
    await readinessResult(config, checks);
    expect(fetchCalls).toBe(2);
  });
});
