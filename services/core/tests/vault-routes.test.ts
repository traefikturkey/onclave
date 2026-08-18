import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PipelineOrchestrator } from "../src/vault/jobs";
import { LLMPricingService, type PricingSnapshotStorage } from "../src/vault/llm-pricing";
import { EdgeType, EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type ContentMetadata, type EntityModel, type JobErrors, type JobTiming, type JsonObject, type PipelineJob } from "../src/vault/models";
import type { SearchService } from "../src/vault/search";
import { createVaultHttpServer } from "../src/vault/http";
import { computeKeyId } from "../src/vault/keys";
import { createVaultRouteHandlers } from "../src/vault/routes";
import { createVaultService, type VaultServiceOverrides } from "../src/vault/vault-service";
import type { VaultConfig } from "../src/vault/config";
import { UnifiedPipeline, type PipelineStorage } from "../src/vault/pipeline";
import type { JobStorage } from "../src/vault/jobs";

const SSH_ED25519 = "ssh-ed25519";

type TestKey = { privateKey: KeyObject; keyId: string; authorizedKeysLine: string };

function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const kind = Buffer.from(SSH_ED25519);
  const kindLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  kindLength.writeUInt32BE(kind.length, 0);
  keyLength.writeUInt32BE(raw.length, 0);
  const blob = Buffer.concat([kindLength, kind, keyLength, raw]);
  return { privateKey, keyId: computeKeyId(blob), authorizedKeysLine: `${SSH_ED25519} ${blob.toString("base64")} operator@example` };
}

/** Mirrors the unmodified dotfiles client signer (tools/menos-youtube/signing.py). */
function signRequest(key: TestKey, method: string, path: string, host: string, body?: Buffer): Record<string, string> {
  const components = ['"@method"', '"@path"', '"@authority"'];
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${host}`];
  let digest: string | undefined;
  if (body !== undefined) {
    components.push('"content-digest"');
    digest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    lines.push(`"content-digest": ${digest}`);
  }
  const params = `(${components.join(" ")});keyid="${key.keyId}";alg="ed25519";created=${Math.floor(Date.now() / 1000)}`;
  lines.push(`"@signature-params": ${params}`);
  const signature = cryptoSign(null, Buffer.from(lines.join("\n")), key.privateKey).toString("base64");
  return { "signature-input": `sig1=${params}`, signature: `sig1=:${signature}:`, ...(digest === undefined ? {} : { "content-digest": digest }) };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return (address as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

function vaultConfig(keysPath: string): VaultConfig {
  return {
    apiBaseUrl: "http://localhost:8000", appVersion: "test", postgresHost: "localhost", postgresPort: 5432, postgresUser: "menos", postgresPassword: "secret", postgresDatabase: "menos", postgresPoolMinSize: 1, postgresPoolMaxSize: 1,
    s3EndpointUrl: "localhost:9000", s3AccessKey: "access", s3SecretKey: "secret", s3Secure: false, s3Bucket: "menos", s3Region: "us-east-1", ollamaUrl: "http://ollama", ollamaModel: "embed", embeddingProvider: "ollama", embeddingModel: "embed", doclingUrl: "http://docling", sshPublicKeysPath: keysPath,
    webshareProxyUsername: "user", webshareProxyPassword: "password", agentExpansionProvider: "none", agentExpansionModel: "", agentRerankProvider: "none", agentRerankModel: "", agentSynthesisProvider: "none", agentSynthesisModel: "", unifiedPipelineEnabled: true, unifiedPipelineProvider: "none", unifiedPipelineModel: "", unifiedPipelineMaxConcurrency: 1, unifiedPipelineMaxNewTags: 3, entityMaxTopicsPerContent: 7, entityMinConfidence: 0.6, entityFetchExternalMetadata: true,
  };
}

describe("vault routes", () => {
  let server: Server;
  let baseUrl: string;
  let key: TestKey;
  let keysDir: string;
  let jobs: PipelineOrchestrator;

  beforeEach(async () => {
    key = testKey();
    keysDir = mkdtempSync(join(tmpdir(), "vault-routes-"));
    const keysPath = join(keysDir, "authorized_keys");
    writeFileSync(keysPath, `${key.authorizedKeysLine}\n`);
    const contents = new Map<string, ContentMetadata>([["video-1", {
      id: "video-1", content_type: "youtube", title: "Existing video", mime_type: "text/plain", file_size: 10, file_path: "youtube/video-1/transcript.txt", tags: ["test", "typescript"], metadata: { video_id: "existing123" }, created_at: new Date("2026-01-01T00:00:00Z"),
    }]]);
    const bytes = new Map<string, Buffer>([["youtube/video-1/transcript.txt", Buffer.from("existing transcript")]]);
    const pipelineJobs = new Map<string, PipelineJob>();
    const entities = new Map<string, EntityModel>([
      ["topic-typescript", { id: "topic-typescript", entity_type: EntityType.TOPIC, name: "TypeScript", normalized_name: "typescript", hierarchy: ["Engineering", "TypeScript"] }],
      ["tool-vitest", { id: "tool-vitest", entity_type: EntityType.TOOL, name: "Vitest", normalized_name: "vitest" }],
    ]);
    const contentEntities = new Map<string, ContentEntityEdge[]>([["video-1", [
      { content_id: "video-1", entity_id: "topic-typescript", edge_type: EdgeType.DISCUSSES },
      { content_id: "video-1", entity_id: "tool-vitest", edge_type: EdgeType.MENTIONS },
    ]]]);
    const processingStatuses = new Map<string, string>([["video-1", JobStatus.COMPLETED]]);
    const repository = {
      async get_content(id: string): Promise<ContentMetadata | undefined> { return contents.get(id); },
      async list_content(): Promise<[ContentMetadata[], number]> { return [[...contents.values()], contents.size]; },
      async get_chunk_counts(): Promise<Record<string, number>> { return { "video-1": 1 }; },
      async get_content_stats(): Promise<{ total: number; by_status: Record<string, number>; by_content_type: Record<string, number> }> { return { total: contents.size, by_status: { completed: 1 }, by_content_type: { youtube: contents.size } }; },
      async list_tags_with_counts(): Promise<readonly Record<string, unknown>[]> { return [{ name: "typescript", count: 1 }]; },
      async get_topic_hierarchy(): Promise<readonly EntityModel[]> { return []; },
      async get_tag_cooccurrence(): Promise<Record<string, string[]>> { return {}; },
      async get_tier_distribution(): Promise<Record<string, number>> { return {}; },
      async get_tag_aliases(): Promise<Record<string, string>> { return {}; },
      async record_tag_alias(): Promise<void> {},
      async find_or_create_entity(name: string, entityType: EntityType, values: Omit<Partial<EntityModel>, "name" | "entity_type" | "normalized_name"> = {}): Promise<readonly [EntityModel, boolean]> {
        const existing = [...entities.values()].find((entity) => entity.entity_type === entityType && entity.normalized_name === name.toLowerCase());
        if (existing !== undefined) return [existing, false];
        const id = `entity-${entities.size + 1}`;
        const entity: EntityModel = { id, entity_type: entityType, name, normalized_name: name.toLowerCase(), hierarchy: values.hierarchy };
        entities.set(id, entity);
        return [entity, true];
      },
      async complete_content_processing(contentId: string, result: JsonObject, _pipelineVersion: string, _chunks: ChunkModel[], relationships: ContentEntityEdge[]): Promise<void> {
        const content = contents.get(contentId);
        if (content === undefined) throw new Error("content not found");
        contents.set(contentId, { ...content, metadata: { ...content.metadata, unified_result: result } });
        contentEntities.set(contentId, relationships.map((relationship) => ({ ...relationship })));
        processingStatuses.set(contentId, JobStatus.COMPLETED);
      },
      async update_content(_id: string, content: ContentMetadata): Promise<ContentMetadata> { return content; },
      async delete_content(id: string): Promise<void> { contents.delete(id); },
      async delete_chunks(): Promise<void> {}, async delete_links_by_source(): Promise<void> {},
      async get_chunks(): Promise<[]> { return []; },
      async find_content_by_parent_id(id: string): Promise<ContentMetadata[]> { return [...contents.values()].filter((item) => item.metadata?.parent_content_id === id); },
      async create_content(content: ContentMetadata): Promise<ContentMetadata> { const id = content.id ?? `content-${contents.size + 1}`; const created = { ...content, id, created_at: new Date() }; contents.set(id, created); return created; },
      async find_content_by_resource_key(keyValue: string): Promise<ContentMetadata | undefined> { return [...contents.values()].find((item) => item.metadata?.resource_key === keyValue); },
      async find_content_by_video_id(videoId: string): Promise<ContentMetadata | undefined> { return [...contents.values()].find((item) => item.metadata?.video_id === videoId); },
      async get_content_processing_status(id: string): Promise<string | undefined> { return processingStatuses.get(id); },
      async update_content_processing_status(id: string, status: string): Promise<void> { processingStatuses.set(id, status); },
      async get_entities_for_content(id: string): Promise<readonly [EntityModel, ContentEntityEdge][]> {
        return (contentEntities.get(id) ?? []).flatMap((edge) => {
          const entity = entities.get(edge.entity_id);
          return entity === undefined ? [] : [[entity, edge] as [EntityModel, ContentEntityEdge]];
        });
      },
      async create_pipeline_job(job: PipelineJob): Promise<PipelineJob> { if (job.id === undefined) throw new Error("job ID is required"); pipelineJobs.set(job.id, { ...job }); return pipelineJobs.get(job.id) ?? job; },
      async get_pipeline_job(id: string): Promise<PipelineJob | undefined> { return pipelineJobs.get(id); },
      async find_active_pipeline_job(resourceKey: string): Promise<PipelineJob | undefined> { return [...pipelineJobs.values()].find((job) => job.resource_key === resourceKey && (job.status === JobStatus.PENDING || job.status === JobStatus.PROCESSING)); },
      async update_pipeline_job(id: string, status: JobStatus, timing: JobTiming, errors: JobErrors): Promise<PipelineJob | undefined> {
        const job = pipelineJobs.get(id);
        if (job === undefined) return undefined;
        const updated = { ...job, status, started_at: timing[0] ?? job.started_at, finished_at: timing[1] ?? job.finished_at, error_code: errors[0] ?? job.error_code, error_message: errors[1] ?? job.error_message, error_stage: errors[2] ?? job.error_stage };
        pipelineJobs.set(id, updated);
        return updated;
      },
      async list_pipeline_jobs(): Promise<readonly [unknown[], number]> { return [[...pipelineJobs.values()], pipelineJobs.size]; },
      async usage_totals(): Promise<Record<string, unknown>> { return { total_calls: 0, total_input_tokens: 0, total_output_tokens: 0, estimated_total_cost: 0 }; },
      async usage_breakdown(): Promise<Record<string, unknown>[]> { return []; },
      async get_pricing_snapshot(): Promise<Record<string, unknown> | undefined> { return undefined; },
      async upsert_pricing_snapshot(): Promise<void> {},
    };
    const storage = {
      async upload(path: string, stream: AsyncIterable<Buffer>): Promise<number> { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(chunk); const body = Buffer.concat(chunks); bytes.set(path, body); return body.length; },
      async download(path: string): Promise<Buffer> { const body = bytes.get(path); if (body === undefined) throw new Error("missing"); return body; },
      async delete(path: string): Promise<void> { bytes.delete(path); },
    };
    const pipelineStorage = repository as unknown as PipelineStorage & JobStorage;
    jobs = new PipelineOrchestrator(new UnifiedPipeline({
      model: "test-model",
      async generate(): Promise<string> {
        return JSON.stringify({
          tags: ["typescript"], tier: "A", quality_score: 82, summary: "A concise summary.",
          topics: [{ name: "Engineering > TypeScript", confidence: "high", edge_type: "discusses" }],
          pre_detected_validations: [],
          additional_entities: [{ type: "tool", name: "Vitest", confidence: "medium", edge_type: "mentions" }],
        });
      },
      async close(): Promise<void> {},
    }, pipelineStorage, vaultConfig(keysPath), { chunkText: (text: string): string[] => [text] }, {
      async embedBatch(texts: readonly string[]): Promise<number[][]> { return texts.map(() => Array.from({ length: 1024 }, () => 0.5)); },
    }), pipelineStorage, { pipelineVersion: "test" });
    const overrides: VaultServiceOverrides = {
      repository: repository as unknown as NonNullable<VaultServiceOverrides["repository"]>, storage,
      jobs,
      search: { async search(query: string): Promise<{ query: string; total: number; results: unknown[] }> { return { query, total: 1, results: [{ id: "video-1", title: "Existing video", snippet: "existing transcript" }] }; } } as unknown as SearchService,
      pricing: new LLMPricingService(repository as unknown as PricingSnapshotStorage),
      transcript: { async fetchTranscript(): Promise<{ videoId: string; segments: []; language: string; fullText: string; timestampedText: string }> { return { videoId: "dQw4w9WgXcQ", segments: [], language: "en", fullText: "youtube transcript", timestampedText: "youtube transcript" }; } },
      youtube: {
        async fetchMetadata(): Promise<never> { throw new Error("metadata unavailable"); },
        async fetchChannelVideosResponse(): Promise<{ source: "youtube-data-api-v3"; videos: [] }> { return { source: "youtube-data-api-v3", videos: [] }; },
      },
      docling: { async extractMarkdown(): Promise<{ markdown: string; title: string }> { return { markdown: "# Page\nBody", title: "Page" }; } },
      readiness: { async postgres(): Promise<void> {}, async s3(): Promise<void> {}, async ollama(): Promise<void> {} },
    };
    const vault = await createVaultService(vaultConfig(keysPath), overrides);
    server = createVaultHttpServer({ keyStore: vault.keyStore, handlers: createVaultRouteHandlers({ ...vault, health: () => ({ status: "ok", git_sha: "test", broker: { connected: false, topologyDeclared: false } }) }) });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => { await close(server); rmSync(keysDir, { recursive: true, force: true }); });

  async function request(path: string, method = "GET", body?: unknown): Promise<Response> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return fetch(`${baseUrl}${path}`, { method, headers: signRequest(key, method, path, new URL(baseUrl).host, bytes), body: bytes });
  }

  it("returns a pollable reprocessing job for duplicate YouTube ingest", async () => {
    const initial = await (await request("/api/v1/ingest", "POST", { url: "https://youtube.com/watch?v=dQw4w9WgXcQ" })).json() as Record<string, unknown>;
    if (typeof initial.job_id !== "string") throw new Error("initial YouTube ingest did not return a job ID");
    await jobs.waitForIdle();

    const duplicate = await (await request("/api/v1/ingest", "POST", { url: "https://youtu.be/dQw4w9WgXcQ" })).json() as Record<string, unknown>;
    expect(duplicate.job_id).toEqual(expect.any(String));
    if (typeof duplicate.job_id !== "string") throw new Error("duplicate YouTube ingest did not return a job ID");

    expect((await request(`/api/v1/jobs/${duplicate.job_id}`)).status).toBe(200);
    await jobs.waitForIdle();
    await expect((await request(`/api/v1/jobs/${duplicate.job_id}`)).json()).resolves.toMatchObject({ job_id: duplicate.job_id, status: JobStatus.COMPLETED });
  });

  it("returns a pollable reprocessing job for duplicate web ingest", async () => {
    const initial = await (await request("/api/v1/ingest", "POST", { url: "https://www.example.com/page?utm_source=test&topic=onclave" })).json() as Record<string, unknown>;
    if (typeof initial.job_id !== "string") throw new Error("initial web ingest did not return a job ID");
    await jobs.waitForIdle();

    const duplicate = await (await request("/api/v1/ingest", "POST", { url: "https://example.com/page?topic=onclave" })).json() as Record<string, unknown>;
    expect(duplicate.job_id).toEqual(expect.any(String));
    if (typeof duplicate.job_id !== "string") throw new Error("duplicate web ingest did not return a job ID");

    expect((await request(`/api/v1/jobs/${duplicate.job_id}`)).status).toBe(200);
    await jobs.waitForIdle();
    await expect((await request(`/api/v1/jobs/${duplicate.job_id}`)).json()).resolves.toMatchObject({ job_id: duplicate.job_id, status: JobStatus.COMPLETED });
  });

  it("serves signed Menos routes and leaves dropped routes unregistered", async () => {
    await expect((await request("/api/v1/content?exclude_tags=")).json()).resolves.toMatchObject({ total: 1, items: [{ id: "video-1", tags: ["test", "typescript"], chunk_count: 1 }] });
    expect((await request("/api/v1/content/missing")).status).toBe(404);
    await expect((await request("/api/v1/content/video-1/download")).text()).resolves.toBe("existing transcript");
    await expect((await request("/api/v1/content/video-1/annotations", "POST", { text: "note", tags: ["note"] })).json()).resolves.toMatchObject({ title: "Annotation for Existing video", tags: ["note"] });
    const ingest = await (await request("/api/v1/ingest?tags=test", "POST", { url: "https://youtube.com/watch?v=dQw4w9WgXcQ" })).json() as Record<string, unknown>;
    expect(ingest).toMatchObject({ title: "YouTube: dQw4w9WgXcQ", content_type: "youtube" });
    expect(typeof ingest.job_id).toBe("string");
    if (typeof ingest.job_id !== "string" || typeof ingest.content_id !== "string") throw new Error("ingest did not return content and job IDs");
    await jobs.waitForIdle();
    await expect((await request(`/api/v1/jobs/${ingest.job_id}`)).json()).resolves.toMatchObject({ status: "completed" });
    await expect((await request(`/api/v1/content/${ingest.content_id}`)).json()).resolves.toMatchObject({
      summary: "A concise summary.",
      topics: ["TypeScript"],
      entities: ["Vitest"],
    });
    await expect((await request("/api/v1/content/video-1")).json()).resolves.toMatchObject({
      topics: ["TypeScript"],
      entities: ["Vitest"],
    });
    expect((await request("/api/v1/content/missing/reprocess", "POST")).status).toBe(404);
    await expect((await request("/api/v1/content/video-1/reprocess", "POST")).json()).resolves.toMatchObject({ status: "already_completed" });
    await expect((await request("/api/v1/search", "POST", { query: "existing", limit: 1 })).json()).resolves.toMatchObject({ total: 1, results: [{ snippet: "existing transcript" }] });
    await expect((await request("/api/v1/youtube/channel?channel=@example")).json()).resolves.toEqual({ source: "youtube-data-api-v3", videos: [] });
    await expect((await request("/api/v1/auth/whoami")).json()).resolves.toEqual({ key_id: key.keyId });
    expect((await fetch(`${baseUrl}/api/v1/content`)).status).toBe(401);
    expect((await request("/api/v1/graph")).status).toBe(404);
    await expect((await fetch(`${baseUrl}/health`)).json()).resolves.toMatchObject({ status: "ok", git_sha: "test", broker: { connected: false } });
    await expect((await fetch(`${baseUrl}/ready`)).json()).resolves.toEqual({ status: "ready", checks: { postgres: "ok", s3: "ok", ollama: "ok" } });
  });
});
