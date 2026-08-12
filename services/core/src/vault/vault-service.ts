import { Client as MinioClient } from "minio";
import type { Pool } from "pg";
import { createVaultPool } from "./db";
import { createEmbeddingService, type EmbeddingService } from "./embeddings";
import type { KeyStore } from "./keys";
import { KeyStore as FileKeyStore } from "./keys";
import { createConfiguredLlmProvider, providerName, type UsageReportingLlmProvider } from "./llm-providers";
import { MeteringLLMProvider, type LlmUsageStorage } from "./llm-metering";
import { LLMPricingService, type PricingSnapshotStorage } from "./llm-pricing";
import { PipelineOrchestrator, type JobStorage } from "./jobs";
import { UnifiedPipeline, type PipelineStorage } from "./pipeline";
import { SearchService, type SearchStorage } from "./search";
import { PostgresRepository, S3Storage } from "./storage";
import { YouTubeTranscriptService } from "./youtube-transcript";
import { YouTubeMetadataService } from "./youtube-metadata";
import { DoclingClient } from "./docling";
import type { VaultConfig } from "./config";
import type { LlmUsage } from "./models";
import type {
  VaultDoclingClient,
  VaultObjectStorage,
  VaultRepository,
  VaultRouteDependencies,
  VaultTranscriptService,
  VaultYouTubeMetadataService,
} from "./routes";
import type { PipelineOrchestrator as PipelineOrchestratorType } from "./jobs";
import type { SearchService as SearchServiceType } from "./search";
import type { UsagePricingService } from "./usage";

type VaultUsageStorage = { record_llm_usage(usage: LlmUsage): Promise<void> };
type VaultRuntimeRepository = VaultRepository & PricingSnapshotStorage & SearchStorage & VaultUsageStorage & PipelineStorage & JobStorage;

export type VaultReadiness = {
  status: "ready" | "degraded";
  checks: { postgres: string; s3: string; ollama: string };
};

export type VaultReadinessChecks = {
  postgres(): Promise<void>;
  s3(): Promise<void>;
  ollama(): Promise<void>;
};

export type VaultService = Omit<VaultRouteDependencies, "health" | "ready"> & {
  ready(): Promise<VaultReadiness>;
  close(): Promise<void>;
};

export type VaultServiceOverrides = {
  keyStore?: KeyStore;
  storage?: VaultObjectStorage;
  repository?: VaultRuntimeRepository;
  embeddings?: EmbeddingService;
  search?: SearchServiceType;
  jobs?: PipelineOrchestratorType;
  pricing?: LLMPricingService;
  transcript?: VaultTranscriptService;
  youtube?: VaultYouTubeMetadataService;
  docling?: VaultDoclingClient;
  readiness?: VaultReadinessChecks;
  close?: () => Promise<void>;
};

function errorValue(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function chunkText(text: string): string[] {
  const normalized = text.trim();
  if (normalized === "") return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += 2000) {
    chunks.push(normalized.slice(offset, offset + 2000));
  }
  return chunks;
}

function configuredReadiness(pool: Pool, storage: S3Storage, config: VaultConfig): VaultReadinessChecks {
  return {
    postgres: async (): Promise<void> => {
      await pool.query("SELECT 1");
    },
    s3: async (): Promise<void> => {
      await storage.client.bucketExists(storage.bucket);
    },
    ollama: async (): Promise<void> => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(new URL("/api/tags", config.ollamaUrl), { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

async function readinessResult(checks: VaultReadinessChecks): Promise<VaultReadiness> {
  const run = async (check: () => Promise<void>): Promise<string> => {
    try {
      await check();
      return "ok";
    } catch (error) {
      return `error: ${errorValue(error)}`;
    }
  };
  const [postgres, s3, ollama] = await Promise.all([run(checks.postgres), run(checks.s3), run(checks.ollama)]);
  return {
    status: postgres === "ok" && s3 === "ok" && ollama === "ok" ? "ready" : "degraded",
    checks: { postgres, s3, ollama },
  };
}

/**
 * Constructs the vault in Menos dependency order. Overrides let in-process
 * callers replace external systems without changing route behavior.
 */
export async function createVaultService(
  config: VaultConfig,
  overrides: VaultServiceOverrides = {},
): Promise<VaultService> {
  const keyStore = overrides.keyStore ?? new FileKeyStore(config.sshPublicKeysPath);
  const pool = overrides.repository === undefined ? createVaultPool(config) : undefined;
  const storage = overrides.storage ?? new S3Storage(new MinioClient({
    endPoint: config.s3EndpointUrl.replace(/^https?:\/\//, "").split(":")[0] ?? config.s3EndpointUrl,
    port: Number.parseInt(config.s3EndpointUrl.replace(/^https?:\/\//, "").split(":")[1] ?? (config.s3Secure ? "443" : "9000"), 10),
    useSSL: config.s3Secure,
    accessKey: config.s3AccessKey,
    secretKey: config.s3SecretKey,
    region: config.s3Region,
  }), config.s3Bucket);
  const repository: VaultRuntimeRepository = overrides.repository ?? new PostgresRepository(pool as Pool);
  const pricing = overrides.pricing ?? new LLMPricingService(repository);
  if (overrides.pricing === undefined) await (pricing as LLMPricingService).initialize();
  const embeddings = overrides.embeddings ?? createEmbeddingService(config);
  const search = overrides.search ?? new SearchService(embeddings, repository);
  let llm: UsageReportingLlmProvider | undefined;
  let jobs = overrides.jobs;
  if (jobs === undefined) {
    llm = createConfiguredLlmProvider(config, "unifiedPipeline");
    const meteringStorage: LlmUsageStorage = {
      record_llm_usage: async ({ created_at: _createdAt, ...usage }): Promise<void> => repository.record_llm_usage(usage),
    };
    const metered = new MeteringLLMProvider(llm, meteringStorage, "pipeline", providerName(llm), llm.model, pricing);
    const pipeline = new UnifiedPipeline(metered, repository, config, { chunkText }, embeddings);
    jobs = new PipelineOrchestrator(pipeline, repository, {
      pipelineVersion: process.env.ONCLAVE_VAULT_APP_VERSION ?? process.env.MENOS_APP_VERSION ?? "0.1.0",
    });
  }
  const transcript = overrides.transcript ?? new YouTubeTranscriptService({
    proxy: { username: config.webshareProxyUsername, password: config.webshareProxyPassword },
  });
  const youtube = overrides.youtube ?? new YouTubeMetadataService(config.youtubeApiKey);
  const docling = overrides.docling ?? new DoclingClient(config.doclingUrl);
  const readiness = overrides.readiness ?? (pool === undefined || !(storage instanceof S3Storage)
    ? { postgres: async (): Promise<void> => {}, s3: async (): Promise<void> => {}, ollama: async (): Promise<void> => {} }
    : configuredReadiness(pool, storage, config));

  return {
    keyStore,
    storage,
    repository,
    jobs,
    search,
    pricing,
    transcript,
    youtube,
    docling,
    ready: async (): Promise<VaultReadiness> => readinessResult(readiness),
    close: async (): Promise<void> => {
      if (overrides.close !== undefined) {
        await overrides.close();
        return;
      }
      if (pricing instanceof LLMPricingService) await pricing.stopScheduler();
      await embeddings.close();
      await llm?.close();
      if (pool !== undefined) await pool.end();
    },
  };
}
