import { Client as MinioClient } from "minio";
import type { Pool } from "pg";
import { createVaultPool, migrateVaultDurability } from "./db";
import { EmbeddingReindexService, type VaultEmbeddingReindexer } from "./embedding-reindex";
import { createEmbeddingService, type EmbeddingClient } from "./embeddings";
import type { KeyStore } from "./keys";
import { KeyStore as FileKeyStore } from "./keys";
import { createConfiguredLlmProvider, providerName, type UsageReportingLlmProvider } from "./llm-providers";
import { MeteringLLMProvider, type LlmUsageStorage } from "./llm-metering";
import { LLMPricingService, type PricingSnapshotStorage } from "./llm-pricing";
import { PipelineOrchestrator, type JobNotificationDelivery, type JobStorage } from "./jobs";
import type { VaultEventSink } from "./durability";
import { UnifiedPipeline, type PipelineStorage } from "./pipeline";
import { SearchService, type SearchStorage } from "./search";
import { PostgresRepository, S3Storage } from "./storage";
import { configuredReadinessChecks, readinessResult, type VaultReadiness, type VaultReadinessChecks } from "./readiness";
import { YouTubeTranscriptService } from "./youtube-transcript";
import { YouTubeMetadataService } from "./youtube-metadata";
import { DoclingClient } from "./docling";
import { SponsorBlockService } from "./sponsorblock";
import { TranscriptArtifactResolver, type TranscriptSponsorBlock } from "./transcript-artifacts";
import type { VaultConfig } from "./config";
import type { ChunkModel, LlmUsage } from "./models";
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

const EMBEDDING_CHUNK_CODE_POINTS = 400;

type VaultUsageStorage = { record_llm_usage(usage: LlmUsage): Promise<void> };
type VaultRuntimeRepository = VaultRepository & PricingSnapshotStorage & SearchStorage & VaultUsageStorage & PipelineStorage & JobStorage & {
  replace_content_chunks(contentId: string, chunks: ChunkModel[]): Promise<void>;
};

export type { VaultReadiness, VaultReadinessChecks } from "./readiness";

export type VaultService = Omit<VaultRouteDependencies, "health" | "ready" | "metrics" | "metricsContentType"> & {
  ready(): Promise<VaultReadiness>;
  close(): Promise<void>;
};

export type VaultServiceOverrides = {
  keyStore?: KeyStore;
  storage?: VaultObjectStorage;
  repository?: VaultRuntimeRepository;
  embeddings?: EmbeddingClient;
  search?: SearchServiceType;
  jobs?: PipelineOrchestratorType;
  pricing?: LLMPricingService;
  transcript?: VaultTranscriptService;
  youtube?: VaultYouTubeMetadataService;
  docling?: VaultDoclingClient;
  embeddingReindexer?: VaultEmbeddingReindexer;
  sponsorblock?: TranscriptSponsorBlock;
  transcriptResolver?: VaultRouteDependencies["transcriptResolver"];
  readiness?: VaultReadinessChecks;
  close?: () => Promise<void>;
  notify?: (agentId: string, delivery: JobNotificationDelivery) => Promise<void>;
  onEvent?: VaultEventSink;
};

export function chunkText(text: string): string[] {
  const normalized = text.trim();
  if (normalized === "") return [];
  const codePoints = [...normalized];
  const chunks: string[] = [];
  for (let offset = 0; offset < codePoints.length; offset += EMBEDDING_CHUNK_CODE_POINTS) {
    chunks.push(codePoints.slice(offset, offset + EMBEDDING_CHUNK_CODE_POINTS).join(""));
  }
  return chunks;
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
  if (pool !== undefined) await migrateVaultDurability(pool);
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
  const embeddingReindexer = overrides.embeddingReindexer ?? new EmbeddingReindexService(
    storage,
    repository,
    embeddings,
    config.embeddingModel,
    chunkText,
  );
  const search = overrides.search ?? new SearchService(embeddings, repository);
  const transcriptResolver = overrides.transcriptResolver ?? new TranscriptArtifactResolver({
    storage,
    repository,
    sponsorblock: overrides.sponsorblock ?? new SponsorBlockService(),
  });
  let llm: UsageReportingLlmProvider | undefined;
  let jobs = overrides.jobs;
  if (jobs === undefined) {
    llm = createConfiguredLlmProvider(config, "unifiedPipeline");
    const meteringStorage: LlmUsageStorage = {
      record_llm_usage: async ({ created_at: _createdAt, ...usage }): Promise<void> => repository.record_llm_usage(usage),
    };
    const metered = new MeteringLLMProvider(llm, meteringStorage, "pipeline", providerName(llm), llm.model, pricing);
    const pipeline = new UnifiedPipeline(metered, repository, { ...config, onEvent: overrides.onEvent }, { chunkText }, embeddings);
    jobs = new PipelineOrchestrator(pipeline, repository, {
      pipelineVersion: config.appVersion,
      notify: overrides.notify,
      transcriptResolver,
      recoveryBatchSize: config.jobRecoveryBatchSize,
      jobLeaseMs: config.jobLeaseMs,
      pollIntervalMs: config.deliveryPollIntervalMs,
      deliveryLeaseMs: config.deliveryLeaseMs,
      deliveryRetryBaseMs: config.deliveryRetryBaseMs,
      deliveryRetryMaxMs: config.deliveryRetryMaxMs,
      deliveryBatchSize: config.deliveryBatchSize,
      onEvent: overrides.onEvent,
    });
  }
  const transcript = overrides.transcript ?? new YouTubeTranscriptService({
    proxy: { username: config.webshareProxyUsername, password: config.webshareProxyPassword },
  });
  const youtube = overrides.youtube ?? new YouTubeMetadataService(config.youtubeApiKey);
  const docling = overrides.docling ?? new DoclingClient(config.doclingUrl);
  const readiness = overrides.readiness ?? (pool === undefined || !(storage instanceof S3Storage)
    ? { postgres: async (): Promise<void> => {}, s3: async (): Promise<void> => {}, ollama: async (): Promise<void> => {} }
    : configuredReadinessChecks(pool, storage, config));

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
    embeddingReindexer,
    transcriptResolver,
    ready: async (): Promise<VaultReadiness> => readinessResult(config, readiness),
    close: async (): Promise<void> => {
      await jobs?.stop();
      if (overrides.close !== undefined) {
        await overrides.close();
        return;
      }
      await transcript.close?.();
      if (pricing instanceof LLMPricingService) await pricing.stopScheduler();
      await embeddings.close();
      await llm?.close();
      if (pool !== undefined) await pool.end();
    },
  };
}
