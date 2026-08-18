export type LlmProviderType = "ollama" | "openai" | "anthropic" | "openrouter" | "none";
export type EmbeddingProviderType = "ollama" | "openrouter";
export type RerankerProviderType = "rerankers" | "llm" | "none";

export type VaultConfig = {
  apiBaseUrl: string;
  appVersion: string;
  postgresHost: string;
  postgresPort: number;
  postgresUser: string;
  postgresPassword: string;
  postgresDatabase: string;
  postgresPoolMinSize: number;
  postgresPoolMaxSize: number;
  s3EndpointUrl: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Secure: boolean;
  s3Bucket: string;
  s3Region: string;
  ollamaUrl: string;
  ollamaModel: string;
  embeddingProvider: EmbeddingProviderType;
  embeddingModel: string;
  doclingUrl: string;
  sshPublicKeysPath: string;
  webshareProxyUsername: string;
  webshareProxyPassword: string;
  youtubeApiKey?: string;
  agentExpansionProvider: LlmProviderType;
  agentExpansionModel: string;
  agentRerankProvider: RerankerProviderType;
  agentRerankModel: string;
  agentSynthesisProvider: LlmProviderType;
  agentSynthesisModel: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  openrouterApiKey?: string;
  unifiedPipelineEnabled: boolean;
  unifiedPipelineProvider: LlmProviderType;
  unifiedPipelineModel: string;
  unifiedPipelineMaxConcurrency: number;
  unifiedPipelineMaxNewTags: number;
  callbackUrl?: string;
  callbackSecret?: string;
  semanticScholarApiKey?: string;
  entityMaxTopicsPerContent: number;
  entityMinConfidence: number;
  entityFetchExternalMetadata: boolean;
};

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`ONCLAVE_VAULT_${name}`];
}

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const result = value(env, name)?.trim();
  return result === "" || result === undefined ? undefined : result;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const result = optional(env, name);
  if (result === undefined) throw new Error(`ONCLAVE_VAULT_${name} is required`);
  return result;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return parsed;
}

function decimal(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`invalid ${name}: ${raw}`);
  }
  return parsed;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (["true", "1", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["false", "0", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`invalid ${name}: ${raw}`);
}

function llmProvider(env: NodeJS.ProcessEnv, name: string, fallback: LlmProviderType): LlmProviderType {
  const result = optional(env, name) ?? fallback;
  if (result === "ollama" || result === "openai" || result === "anthropic" || result === "openrouter" || result === "none") return result;
  throw new Error(`invalid ${name}: ${result}`);
}

function embeddingProvider(env: NodeJS.ProcessEnv, name: string, fallback: EmbeddingProviderType): EmbeddingProviderType {
  const result = optional(env, name) ?? fallback;
  if (result === "ollama" || result === "openrouter") return result;
  throw new Error(`invalid ${name}: ${result}`);
}

function rerankerProvider(env: NodeJS.ProcessEnv, name: string, fallback: RerankerProviderType): RerankerProviderType {
  const result = optional(env, name) ?? fallback;
  if (result === "rerankers" || result === "llm" || result === "none") return result;
  throw new Error(`invalid ${name}: ${result}`);
}

export function loadVaultConfig(env: NodeJS.ProcessEnv = process.env): VaultConfig {
  const postgresPoolMinSize = integer(env, "POSTGRES_POOL_MIN_SIZE", 1, 0);
  const postgresPoolMaxSize = integer(env, "POSTGRES_POOL_MAX_SIZE", 10, 1);
  if (postgresPoolMinSize > postgresPoolMaxSize) {
    throw new Error("POSTGRES_POOL_MIN_SIZE must not exceed POSTGRES_POOL_MAX_SIZE");
  }
  const ollamaModel = optional(env, "OLLAMA_MODEL") ?? "mxbai-embed-large";
  const configuredEmbeddingProvider = embeddingProvider(env, "EMBEDDING_PROVIDER", "ollama");
  return {
    apiBaseUrl: optional(env, "API_BASE_URL") ?? "http://localhost:8000",
    appVersion: optional(env, "APP_VERSION") ?? "0.1.0",
    postgresHost: optional(env, "POSTGRES_HOST") ?? "localhost",
    postgresPort: integer(env, "POSTGRES_PORT", 5432, 1),
    postgresUser: optional(env, "POSTGRES_USER") ?? "menos",
    postgresPassword: required(env, "POSTGRES_PASSWORD"),
    postgresDatabase: optional(env, "POSTGRES_DATABASE") ?? "menos",
    postgresPoolMinSize,
    postgresPoolMaxSize,
    s3EndpointUrl: optional(env, "S3_ENDPOINT_URL") ?? "localhost:9000",
    s3AccessKey: required(env, "S3_ACCESS_KEY"),
    s3SecretKey: required(env, "S3_SECRET_KEY"),
    s3Secure: boolean(env, "S3_SECURE", false),
    s3Bucket: optional(env, "S3_BUCKET") ?? "menos",
    s3Region: optional(env, "S3_REGION") ?? "us-east-1",
    ollamaUrl: optional(env, "OLLAMA_URL") ?? "http://localhost:11434",
    ollamaModel,
    embeddingProvider: configuredEmbeddingProvider,
    embeddingModel: optional(env, "EMBEDDING_MODEL") ?? (configuredEmbeddingProvider === "openrouter" ? "intfloat/e5-large-v2" : ollamaModel),
    doclingUrl: optional(env, "DOCLING_URL") ?? "http://docling-serve:5001",
    sshPublicKeysPath: optional(env, "SSH_PUBLIC_KEYS_PATH") ?? "/keys",
    webshareProxyUsername: required(env, "WEBSHARE_PROXY_USERNAME"),
    webshareProxyPassword: required(env, "WEBSHARE_PROXY_PASSWORD"),
    youtubeApiKey: optional(env, "YOUTUBE_API_KEY"),
    agentExpansionProvider: llmProvider(env, "AGENT_EXPANSION_PROVIDER", "openrouter"),
    agentExpansionModel: optional(env, "AGENT_EXPANSION_MODEL") ?? "",
    agentRerankProvider: rerankerProvider(env, "AGENT_RERANK_PROVIDER", "none"),
    agentRerankModel: optional(env, "AGENT_RERANK_MODEL") ?? "cross-encoder/ms-marco-MiniLM-L-12-v2",
    agentSynthesisProvider: llmProvider(env, "AGENT_SYNTHESIS_PROVIDER", "openrouter"),
    agentSynthesisModel: optional(env, "AGENT_SYNTHESIS_MODEL") ?? "",
    openaiApiKey: optional(env, "OPENAI_API_KEY"),
    anthropicApiKey: optional(env, "ANTHROPIC_API_KEY"),
    openrouterApiKey: optional(env, "OPENROUTER_API_KEY"),
    unifiedPipelineEnabled: boolean(env, "UNIFIED_PIPELINE_ENABLED", true),
    unifiedPipelineProvider: llmProvider(env, "UNIFIED_PIPELINE_PROVIDER", "openrouter"),
    unifiedPipelineModel: optional(env, "UNIFIED_PIPELINE_MODEL") ?? "",
    unifiedPipelineMaxConcurrency: integer(env, "UNIFIED_PIPELINE_MAX_CONCURRENCY", 4, 1),
    unifiedPipelineMaxNewTags: integer(env, "UNIFIED_PIPELINE_MAX_NEW_TAGS", 3, 0),
    callbackUrl: optional(env, "CALLBACK_URL"),
    callbackSecret: optional(env, "CALLBACK_SECRET"),
    semanticScholarApiKey: optional(env, "SEMANTIC_SCHOLAR_API_KEY"),
    entityMaxTopicsPerContent: integer(env, "ENTITY_MAX_TOPICS_PER_CONTENT", 7, 0),
    entityMinConfidence: decimal(env, "ENTITY_MIN_CONFIDENCE", 0.6, 0),
    entityFetchExternalMetadata: boolean(env, "ENTITY_FETCH_EXTERNAL_METADATA", true),
  };
}
