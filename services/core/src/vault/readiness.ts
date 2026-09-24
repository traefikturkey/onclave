import type { LlmProviderType, VaultConfig } from "./config";

const PROBE_TIMEOUT_MS = 5_000;
const CLOUD_PROBE_CACHE_TTL_MS = 5_000;

export type VaultReadinessCheckStatus =
  | "ok"
  | "skipped"
  | "error:timeout"
  | "error:unavailable"
  | "error:missing_credential"
  | "error:unauthorized"
  | "error:not_configured";

export type VaultReadinessChecksResult = {
  postgres: VaultReadinessCheckStatus;
  s3: VaultReadinessCheckStatus;
  ollama: VaultReadinessCheckStatus;
} & Partial<Record<Exclude<LlmProviderType, "none" | "ollama">, VaultReadinessCheckStatus>>;

export type VaultReadiness = {
  status: "ready" | "degraded";
  checks: VaultReadinessChecksResult;
};

export type VaultReadinessCheck = () => Promise<void | VaultReadinessCheckStatus>;

export type VaultReadinessChecks = {
  postgres: VaultReadinessCheck;
  s3: VaultReadinessCheck;
  ollama: VaultReadinessCheck;
  openai?: VaultReadinessCheck;
  anthropic?: VaultReadinessCheck;
  openrouter?: VaultReadinessCheck;
};

export type ReadinessFetcher = (url: string, init?: RequestInit) => Promise<Response>;

type ReadinessPool = {
  query(config: { text: string; query_timeout: number }): Promise<unknown>;
};

type ReadinessObjectStorage = {
  bucket: string;
  client: { bucketExists(bucket: string): Promise<boolean> };
};

type ConfiguredReadinessOptions = {
  fetcher?: ReadinessFetcher;
  now?: () => number;
};

class ReadinessProbeFailure extends Error {
  readonly status: VaultReadinessCheckStatus;

  constructor(status: VaultReadinessCheckStatus) {
    super(status);
    this.name = "ReadinessProbeFailure";
    this.status = status;
  }
}

function requiredProviders(config: VaultConfig): Set<Exclude<LlmProviderType, "none">> {
  const required = new Set<Exclude<LlmProviderType, "none">>([config.embeddingProvider]);
  if (config.unifiedPipelineEnabled && config.unifiedPipelineProvider !== "none") {
    required.add(config.unifiedPipelineProvider);
  }
  return required;
}

function failureStatus(error: unknown): VaultReadinessCheckStatus {
  if (error instanceof ReadinessProbeFailure) return error.status;
  if (error instanceof DOMException && error.name === "AbortError") return "error:timeout";
  if (error instanceof Error && error.name === "AbortError") return "error:timeout";
  return "error:unavailable";
}

async function bounded(check: VaultReadinessCheck): Promise<VaultReadinessCheckStatus> {
  let timeout: NodeJS.Timeout | undefined;
  const deadline = new Promise<VaultReadinessCheckStatus>((resolve) => {
    timeout = setTimeout(() => resolve("error:timeout"), PROBE_TIMEOUT_MS);
  });
  const probe = Promise.resolve()
    .then(check)
    .then((status) => status ?? "ok" as const)
    .catch(failureStatus);
  try {
    return await Promise.race([probe, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function httpProbe(
  fetcher: ReadinessFetcher,
  url: string,
  headers: Record<string, string> = {},
): Promise<VaultReadinessCheckStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetcher(url, { method: "GET", headers, signal: controller.signal });
    if (response.ok) return "ok";
    return response.status === 401 || response.status === 403 ? "error:unauthorized" : "error:unavailable";
  } catch (error: unknown) {
    return failureStatus(error);
  } finally {
    clearTimeout(timeout);
  }
}

function cachedCloudProbe(
  probe: () => Promise<VaultReadinessCheckStatus>,
  now: () => number,
): VaultReadinessCheck {
  let cached: { status: VaultReadinessCheckStatus; expiresAt: number } | undefined;
  let inFlight: Promise<VaultReadinessCheckStatus> | undefined;
  return (): Promise<VaultReadinessCheckStatus> => {
    if (cached !== undefined && now() < cached.expiresAt) return Promise.resolve(cached.status);
    if (inFlight !== undefined) return inFlight;
    const current = probe()
      .catch(failureStatus)
      .then((status) => {
        cached = { status, expiresAt: now() + CLOUD_PROBE_CACHE_TTL_MS };
        return status;
      })
      .finally(() => {
        if (inFlight === current) inFlight = undefined;
      });
    inFlight = current;
    return current;
  };
}

function credentialProbe(
  credential: string | undefined,
  probe: (credential: string) => Promise<VaultReadinessCheckStatus>,
  now: () => number,
): VaultReadinessCheck {
  return cachedCloudProbe(
    () => credential === undefined || credential.trim() === ""
      ? Promise.resolve("error:missing_credential")
      : probe(credential),
    now,
  );
}

export function configuredReadinessChecks(
  pool: ReadinessPool,
  storage: ReadinessObjectStorage,
  config: VaultConfig,
  options: ConfiguredReadinessOptions = {},
): VaultReadinessChecks {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const required = requiredProviders(config);
  const checks: VaultReadinessChecks = {
    postgres: async (): Promise<void> => {
      await pool.query({ text: "SELECT 1", query_timeout: PROBE_TIMEOUT_MS });
    },
    s3: async (): Promise<void> => {
      if (!await storage.client.bucketExists(storage.bucket)) {
        throw new ReadinessProbeFailure("error:unavailable");
      }
    },
    ollama: () => httpProbe(fetcher, new URL("/api/tags", config.ollamaUrl).toString()),
  };
  if (required.has("openrouter")) {
    checks.openrouter = credentialProbe(
      config.openrouterApiKey,
      (credential) => httpProbe(fetcher, "https://openrouter.ai/api/v1/auth/key", { authorization: `Bearer ${credential}` }),
      now,
    );
  }
  if (required.has("openai")) {
    checks.openai = credentialProbe(
      config.openaiApiKey,
      (credential) => httpProbe(fetcher, "https://api.openai.com/v1/models", { authorization: `Bearer ${credential}` }),
      now,
    );
  }
  if (required.has("anthropic")) {
    checks.anthropic = credentialProbe(
      config.anthropicApiKey,
      (credential) => httpProbe(fetcher, "https://api.anthropic.com/v1/models", {
        "anthropic-version": "2023-06-01",
        "x-api-key": credential,
      }),
      now,
    );
  }
  return checks;
}

export async function readinessResult(config: VaultConfig, checks: VaultReadinessChecks): Promise<VaultReadiness> {
  const required = requiredProviders(config);
  const postgres = bounded(checks.postgres);
  const s3 = bounded(checks.s3);
  const ollama = required.has("ollama") ? bounded(checks.ollama) : Promise.resolve("skipped" as const);
  const providerOrder = ["openrouter", "openai", "anthropic"] as const;
  const providerResults = Promise.all(providerOrder.map(async (provider) => {
    if (!required.has(provider)) return undefined;
    const check = checks[provider];
    return [provider, check === undefined ? "error:not_configured" : await bounded(check)] as const;
  }));
  const [postgresStatus, s3Status, ollamaStatus, selectedProviders] = await Promise.all([
    postgres,
    s3,
    ollama,
    providerResults,
  ]);
  const result: VaultReadinessChecksResult = {
    postgres: postgresStatus,
    s3: s3Status,
    ollama: ollamaStatus,
  };
  for (const selected of selectedProviders) {
    if (selected !== undefined) result[selected[0]] = selected[1];
  }
  return {
    status: Object.values(result).every((status) => status === "ok" || status === "skipped") ? "ready" : "degraded",
    checks: result,
  };
}
