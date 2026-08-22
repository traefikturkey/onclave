import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { HttpError } from "./errors";
import type { VaultEmbeddingReindexer } from "./embedding-reindex";
import type { KeyStore } from "./keys";
import { EntityType, JobStatus, type ChunkModel, type ContentEntityEdge, type ContentMetadata, type EntityModel, type JsonObject, type JsonValue } from "./models";
import type { PipelineOrchestrator } from "./jobs";
import type { SearchService } from "./search";
import type { UsagePricingService, UsageStorage } from "./usage";
import { getUsage, toUsageQuery } from "./usage";
import type { DoclingResult } from "./docling";
import type { YouTubeMetadata, YouTubeChannelVideos } from "./youtube-metadata";
import type { YouTubeTranscript } from "./youtube-transcript";
import { TranscriptUpstreamUnavailable } from "./youtube-transcript";
import { UrlDetector } from "./url-detector";
import { jsonResponse, rawResponse, type VaultHandlers } from "./http";

export type VaultObjectStorage = {
  upload(filePath: string, data: Readable, contentType: string): Promise<number>;
  download(filePath: string): Promise<Buffer>;
  delete(filePath: string): Promise<void>;
};

export type VaultRepository = UsageStorage & {
  get_content(contentId: string): Promise<ContentMetadata | undefined>;
  list_content(options?: {
    offset?: number;
    limit?: number;
    content_type?: string;
    tags?: string[];
    exclude_tags?: string[];
    order_by?: string;
  }): Promise<[ContentMetadata[], number]>;
  get_chunk_counts(contentIds: string[]): Promise<Record<string, number>>;
  get_content_stats(): Promise<{ total: number; by_status: Record<string, number>; by_content_type: Record<string, number> }>;
  list_tags_with_counts(): Promise<readonly Record<string, unknown>[]>;
  update_content(contentId: string, metadata: ContentMetadata): Promise<ContentMetadata>;
  delete_content(contentId: string): Promise<void>;
  delete_chunks(contentId: string): Promise<void>;
  delete_links_by_source(contentId: string): Promise<void>;
  get_chunks(contentId: string): Promise<ChunkModel[]>;
  find_content_by_parent_id(parentContentId: string, contentType?: string): Promise<ContentMetadata[]>;
  create_content(metadata: ContentMetadata): Promise<ContentMetadata>;
  find_content_by_resource_key(resourceKey: string): Promise<ContentMetadata | undefined>;
  find_content_by_video_id(videoId: string): Promise<ContentMetadata | undefined>;
  get_content_processing_status(contentId: string): Promise<string | undefined>;
  get_entities_for_content(contentId: string): Promise<readonly [EntityModel, ContentEntityEdge][]>;
};

export type VaultTranscriptService = {
  fetchTranscript(videoId: string): Promise<YouTubeTranscript>;
  close?(): Promise<void>;
};

export type VaultYouTubeMetadataService = {
  fetchMetadata(videoId: string): Promise<YouTubeMetadata>;
  fetchChannelVideosResponse(channel: string, limit?: number): Promise<YouTubeChannelVideos>;
};

export type VaultDoclingClient = {
  extractMarkdown(url: string): Promise<DoclingResult>;
};

export type VaultRouteDependencies = {
  keyStore: KeyStore;
  storage: VaultObjectStorage;
  repository: VaultRepository;
  jobs: PipelineOrchestrator;
  search: SearchService;
  pricing: UsagePricingService;
  transcript: VaultTranscriptService;
  youtube: VaultYouTubeMetadataService;
  docling: VaultDoclingClient;
  embeddingReindexer: VaultEmbeddingReindexer;
  health: () => Record<string, unknown> | Promise<Record<string, unknown>>;
  ready: () => Promise<Record<string, unknown>>;
  authorizeNotificationAgent?: (agentId: string, keyId: string | undefined) => void;
};

type RequestObject = Record<string, unknown>;

function validationError(location: string, message: string, type = "value_error"): HttpError {
  return new HttpError(422, [{ loc: ["query", location], msg: message, type }]);
}

function bodyValidationError(location: string, message: string, type = "value_error"): HttpError {
  return new HttpError(422, [{ loc: ["body", location], msg: message, type }]);
}

function parseJsonObject(body: Buffer): RequestObject {
  try {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw bodyValidationError("", "Input should be a valid dictionary", "dict_type");
    }
    return value as RequestObject;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw bodyValidationError("", "JSON decode error", "json_invalid");
  }
}

function requiredText(body: RequestObject, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw bodyValidationError(field, "Field required", "missing");
  return value;
}

function optionalText(body: RequestObject, field: string): string | undefined {
  const value = body[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw bodyValidationError(field, "Input should be a valid string", "string_type");
  return value;
}

function stringList(value: unknown, location: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw bodyValidationError(location, "Input should be a valid list", "list_type");
  }
  return value;
}

function optionalStringList(body: RequestObject, field: string): string[] | undefined {
  const value = body[field];
  return value === undefined || value === null ? undefined : stringList(value, field);
}

function integerQuery(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!/^-?\d+$/.test(value)) throw validationError(name, "Input should be a valid integer", "int_parsing");
  const parsed = Number.parseInt(value, 10);
  if (parsed < minimum || parsed > maximum) {
    throw validationError(name, `Input should be greater than or equal to ${minimum} and less than or equal to ${maximum}`, "greater_than_equal");
  }
  return parsed;
}

function booleanQuery(value: string | undefined, name: string, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (["true", "1", "on", "yes"].includes(value.toLowerCase())) return true;
  if (["false", "0", "off", "no"].includes(value.toLowerCase())) return false;
  throw validationError(name, "Input should be a valid boolean", "bool_parsing");
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]));
  }
  return String(value);
}

function date(value: Date | null | undefined): string | null {
  return value === undefined || value === null ? null : value.toISOString();
}

function contentId(content: ContentMetadata): string {
  return content.id ?? "";
}

function submittedJobId(job: { id?: string }): string {
  if (job.id === undefined || job.id === "") throw new Error("Pipeline submission did not return a job ID");
  return job.id;
}

async function resubmitExistingIngest(deps: VaultRouteDependencies, content: ContentMetadata, resourceKey: string, fallbackTitle: string, notifyAgentId?: string): Promise<string> {
  const id = contentId(content);
  if (id === "") throw new Error("Existing content does not have an ID");
  let contentText: string;
  try {
    contentText = (await deps.storage.download(content.file_path)).toString("utf8");
  } catch (error) {
    throw new HttpError(500, `Failed to download content: ${error instanceof Error ? error.message : String(error)}`);
  }
  const job = await deps.jobs.submit({
    contentId: id,
    contentText,
    contentType: content.content_type,
    title: content.title ?? fallbackTitle,
    resourceKey,
    notifyAgentId,
  });
  return submittedJobId(job);
}

function splitTags(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",").map((tag) => tag.trim()).filter(Boolean);
}

function effectiveExcludeTags(excludeTags: string | undefined, tags: string[] | undefined): string[] | undefined {
  const parsed = splitTags(excludeTags);
  if (tags?.includes("test")) return (parsed ?? []).filter((tag) => tag !== "test");
  return parsed;
}

function metadataValue(content: ContentMetadata): Record<string, JsonValue> {
  return record(content.metadata);
}

function pipelineFields(content: ContentMetadata, persistedEntities: readonly EntityModel[]): { summary: string | null; topics: string[]; entities: string[]; pipelineTags: string[] } {
  const unified = record(metadataValue(content).unified_result);
  const names = (value: JsonValue | undefined): string[] => Array.isArray(value)
    ? value.flatMap((item) => {
      const itemRecord = record(item);
      return typeof itemRecord.name === "string" ? [itemRecord.name] : [];
    })
    : [];
  const uniqueNames = (entities: readonly EntityModel[]): string[] => [...new Set(entities.flatMap((entity) => entity.name === "" ? [] : [entity.name]))];
  const topics = uniqueNames(persistedEntities.filter((entity) => entity.entity_type === EntityType.TOPIC));
  const entities = uniqueNames(persistedEntities.filter((entity) => entity.entity_type !== EntityType.TOPIC));
  return {
    summary: typeof unified.summary === "string" && unified.summary !== "" ? unified.summary : null,
    topics: topics.length > 0 ? topics : names(unified.topics),
    entities: entities.length > 0 ? entities : names(unified.additional_entities),
    pipelineTags: Array.isArray(unified.tags) ? unified.tags.filter((item): item is string => typeof item === "string") : [],
  };
}

function contentDetail(content: ContentMetadata, processingStatus: string | undefined, persistedEntities: readonly EntityModel[]): Record<string, unknown> {
  const fields = pipelineFields(content, persistedEntities);
  const unified = record(metadataValue(content).unified_result);
  return {
    id: contentId(content),
    content_type: content.content_type,
    title: content.title ?? null,
    description: content.description ?? null,
    mime_type: content.mime_type,
    file_size: content.file_size,
    file_path: content.file_path,
    tags: content.tags ?? [],
    created_at: date(content.created_at),
    updated_at: date(content.updated_at),
    processing_status: processingStatus ?? null,
    summary: fields.summary,
    structured_summary: unified.structured_summary,
    quality_tier: typeof unified.tier === "string" && unified.tier !== "" ? unified.tier : null,
    quality_score: typeof unified.quality_score === "number" ? unified.quality_score : null,
    pipeline_tags: fields.pipelineTags,
    topics: fields.topics,
    entities: fields.entities,
    metadata: content.metadata ?? {},
  };
}

function urlIsHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function canonicalWebUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const port = url.port === "" ? "" : `:${url.port}`;
  const path = url.pathname !== "/" ? url.pathname.replace(/\/+$/, "") : url.pathname;
  const query = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith("utm_") && !key.toLowerCase().endsWith("clid"))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
  const search = new URLSearchParams(query).toString();
  return `${url.protocol}//${host}${port}${path}${search === "" ? "" : `?${search}`}`;
}

function youtubeMetadataJson(videoId: string, resourceKey: string, metadata: YouTubeMetadata | null, clientMetadata: JsonObject): JsonObject {
  return {
    video_id: videoId,
    resource_key: resourceKey,
    published_at: metadata?.publishedAt ?? null,
    fetched_at: metadata?.fetchedAt ?? null,
    channel_id: metadata?.channelId ?? null,
    channel_title: metadata?.channelTitle ?? null,
    duration_seconds: metadata?.durationSeconds ?? null,
    view_count: metadata?.viewCount ?? null,
    like_count: metadata?.likeCount ?? null,
    description_urls: metadata?.descriptionUrls ?? [],
    ...clientMetadata,
  };
}

function contentFilename(path: string): string {
  return path.split("/").at(-1) ?? "download";
}

function statusFromQuery(value: string | undefined): JobStatus | undefined {
  if (value === undefined) return undefined;
  if (Object.values(JobStatus).includes(value as JobStatus)) return value as JobStatus;
  throw new HttpError(400, `Invalid status: ${value}. Valid: ${Object.values(JobStatus).join(", ")}`);
}

function usageDate(value: string | undefined, name: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw validationError(name, "Input should be a valid datetime", "datetime_parsing");
  return parsed;
}

/** Builds all keep and keep-thin Menos route handlers. Dropped routes are intentionally absent. */
export function createVaultRouteHandlers(deps: VaultRouteDependencies): VaultHandlers {
  return {
    health: async () => jsonResponse(await deps.health()),
    ready: async () => {
      const result = await deps.ready();
      return jsonResponse(result, result.status === "ready" ? 200 : 503);
    },
    authKeys: () => jsonResponse({ keys: deps.keyStore.listKeyIds() }),
    authKeysReload: () => {
      deps.keyStore.reload();
      return jsonResponse({ status: "reloaded", keys: deps.keyStore.listKeyIds() });
    },
    authWhoami: (request) => jsonResponse({ key_id: request.keyId }),
    contentList: async (request) => {
      const limit = integerQuery(request.query.limit, "limit", 50, 1, 100);
      const offset = integerQuery(request.query.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      const tags = splitTags(request.query.tags);
      const [contents, total] = await deps.repository.list_content({
        content_type: request.query.content_type,
        tags,
        exclude_tags: effectiveExcludeTags(request.query.exclude_tags, tags),
        limit,
        offset,
        order_by: "created_at DESC",
      });
      const counts = await deps.repository.get_chunk_counts(contents.flatMap((content) => content.id === undefined ? [] : [content.id]));
      const statuses = await Promise.all(contents.map(async (content) => [contentId(content), await deps.repository.get_content_processing_status(contentId(content))] as const));
      const statusById = new Map(statuses);
      return jsonResponse({
        items: contents.map((content) => ({
          id: contentId(content),
          content_type: content.content_type,
          title: content.title ?? null,
          status: statusById.get(contentId(content)) ?? null,
          created_at: date(content.created_at) ?? "",
          chunk_count: counts[contentId(content)] ?? 0,
          tags: content.tags ?? [],
          metadata: content.metadata ?? {},
        })),
        total,
        offset,
        limit,
      });
    },
    contentStats: async () => jsonResponse(await deps.repository.get_content_stats()),
    contentTags: async () => jsonResponse({
      tags: (await deps.repository.list_tags_with_counts()).map((tag) => ({ name: String(tag.name ?? ""), count: Number(tag.count ?? 0) })),
    }),
    contentDetail: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      const [processingStatus, entitiesWithEdges] = await Promise.all([
        deps.repository.get_content_processing_status(id),
        deps.repository.get_entities_for_content(id),
      ]);
      return jsonResponse(contentDetail(content, processingStatus, entitiesWithEdges.map(([entity]) => entity)));
    },
    contentUpdate: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      const body = parseJsonObject(request.body);
      const tags = optionalStringList(body, "tags");
      const title = optionalText(body, "title");
      const description = optionalText(body, "description");
      if (tags !== undefined) content.tags = tags;
      if (title !== undefined) content.title = title;
      if (description !== undefined) content.description = description;
      const updated = await deps.repository.update_content(id, content);
      return jsonResponse({
        id: contentId(updated), content_type: updated.content_type, title: updated.title ?? null,
        description: updated.description ?? null, created_at: date(updated.created_at), updated_at: date(updated.updated_at),
        tags: updated.tags ?? [], metadata: updated.metadata ?? {},
      });
    },
    contentDelete: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      await deps.storage.delete(content.file_path);
      await deps.repository.delete_chunks(id);
      await deps.repository.delete_links_by_source(id);
      await deps.repository.delete_content(id);
      return jsonResponse({ status: "deleted", id });
    },
    contentAnnotationsCreate: async (request) => {
      const parentId = request.params.content_id ?? "";
      const parent = await deps.repository.get_content(parentId);
      if (parent === undefined) throw new HttpError(404, "Content not found");
      const body = parseJsonObject(request.body);
      const text = requiredText(body, "text");
      const title = optionalText(body, "title") ?? `Annotation for ${parent.title ?? parentId}`;
      const sourceType = optionalText(body, "source_type") ?? "screenshot";
      const tags = optionalStringList(body, "tags") ?? [];
      const id = createHash("sha256").update(text).update(new Date().toISOString()).digest("hex").slice(0, 12);
      const filePath = `annotations/${parentId}/${id}.md`;
      const fileSize = await deps.storage.upload(filePath, Readable.from(Buffer.from(text, "utf8")), "text/markdown");
      const created = await deps.repository.create_content({
        content_type: "annotation", title, mime_type: "text/markdown", file_size: fileSize, file_path: filePath,
        author: request.keyId ?? null, tags, metadata: { parent_content_id: parentId, source_type: sourceType },
      });
      return jsonResponse({
        id: contentId(created) || id, parent_content_id: parentId, text, title, source_type: sourceType,
        tags, created_at: date(created.created_at),
      });
    },
    contentAnnotationsList: async (request) => {
      const parentId = request.params.content_id ?? "";
      const annotations = await deps.repository.find_content_by_parent_id(parentId, "annotation");
      const results = await Promise.all(annotations.map(async (annotation) => {
        let text = "";
        try {
          text = (await deps.storage.download(annotation.file_path)).toString("utf8");
        } catch {
          text = "";
        }
        const metadata = metadataValue(annotation);
        return {
          id: contentId(annotation), parent_content_id: typeof metadata.parent_content_id === "string" ? metadata.parent_content_id : parentId,
          text, title: annotation.title ?? null, source_type: typeof metadata.source_type === "string" ? metadata.source_type : "screenshot",
          tags: annotation.tags ?? [], created_at: date(annotation.created_at),
        };
      }));
      return jsonResponse(results);
    },
    contentChunks: async (request) => {
      const id = request.params.content_id ?? "";
      if (await deps.repository.get_content(id) === undefined) throw new HttpError(404, "Content not found");
      const includeEmbeddings = booleanQuery(request.query.include_embeddings, "include_embeddings");
      const chunks = await deps.repository.get_chunks(id);
      return jsonResponse({
        items: chunks.map((chunk) => ({ id: chunk.id ?? null, chunk_index: chunk.chunk_index, text: chunk.text, embedding: includeEmbeddings ? chunk.embedding ?? null : null })),
        total: chunks.length,
      });
    },
    contentDownload: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      try {
        return rawResponse(await deps.storage.download(content.file_path), content.mime_type, 200, {
          "content-disposition": `attachment; filename="${contentFilename(content.file_path)}"`,
        });
      } catch {
        throw new HttpError(404, "File not found in storage");
      }
    },
    contentReprocess: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      const force = booleanQuery(request.query.force, "force");
      if (!force && await deps.repository.get_content_processing_status(id) === "completed") {
        return jsonResponse({ content_id: id, status: "already_completed", job_id: null });
      }
      let contentText: string;
      try {
        contentText = (await deps.storage.download(content.file_path)).toString("utf8");
      } catch (error) {
        throw new HttpError(500, `Failed to download content: ${error instanceof Error ? error.message : String(error)}`);
      }
      const job = await deps.jobs.reprocess({ contentId: id, contentText });
      return jsonResponse({ content_id: id, status: "submitted", job_id: job?.id ?? null });
    },
    contentEmbeddingsReindex: async (request) => {
      const id = request.params.content_id ?? "";
      const content = await deps.repository.get_content(id);
      if (content === undefined) throw new HttpError(404, "Content not found");
      try {
        const result = await deps.embeddingReindexer.reindex(content);
        return jsonResponse({ content_id: id, status: "completed", ...result });
      } catch (error) {
        throw new HttpError(500, `Embedding reindex failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    ingest: async (request) => {
      const body = parseJsonObject(request.body);
      const url = requiredText(body, "url");
      if (!urlIsHttp(url)) throw bodyValidationError("url", "Input should be a valid URL", "url_parsing");
      const transcriptText = optionalText(body, "transcript_text");
      if (transcriptText !== undefined && transcriptText.trim() === "") {
        throw bodyValidationError("transcript_text", "transcript_text must not be empty");
      }
      if (transcriptText !== undefined && Buffer.byteLength(transcriptText, "utf8") > 5 * 1024 * 1024) {
        throw new HttpError(413, "transcript_text exceeds 5 MB");
      }
      const transcriptFormat = optionalText(body, "transcript_format") ?? "plain";
      if (transcriptFormat !== "plain") throw bodyValidationError("transcript_format", "Input should be 'plain'", "literal_error");
      const suppliedMetadata = body.metadata === undefined || body.metadata === null ? {} : toJsonValue(body.metadata);
      if (Array.isArray(suppliedMetadata) || suppliedMetadata === null || typeof suppliedMetadata !== "object") {
        throw bodyValidationError("metadata", "Input should be a valid dictionary", "dict_type");
      }
      const clientMetadata: JsonObject = { ...(suppliedMetadata as JsonObject) };
      const notifyAgentId = optionalText(body, "notify_agent_id");
      if (notifyAgentId !== undefined) {
        if (deps.authorizeNotificationAgent === undefined) throw new HttpError(503, "Job notifications are unavailable");
        deps.authorizeNotificationAgent(notifyAgentId, request.keyId);
      }
      const suppliedTitle = optionalText(body, "title");
      if (suppliedTitle !== undefined) clientMetadata.title = suppliedTitle;
      const tags = splitTags(request.query.tags) ?? [];
      const detected = new UrlDetector().classifyUrl(url);
      if (detected.urlType === "youtube") {
        const videoId = detected.extractedId;
        const resourceKey = `yt:${videoId}`;
        const existing = await deps.repository.find_content_by_resource_key(resourceKey) ?? await deps.repository.find_content_by_video_id(videoId);
        if (existing !== undefined) {
          const title = existing.title ?? `YouTube: ${videoId}`;
          const jobId = await resubmitExistingIngest(deps, existing, resourceKey, title, notifyAgentId);
          return jsonResponse({ content_id: contentId(existing), content_type: existing.content_type, title, job_id: jobId });
        }
        let transcript: YouTubeTranscript | undefined;
        let processingText = transcriptText;
        let storedText = transcriptText;
        if (processingText === undefined) {
          try {
            transcript = await deps.transcript.fetchTranscript(videoId);
          } catch (error) {
            if (error instanceof TranscriptUpstreamUnavailable) throw new HttpError(503, "YouTube transcript service is temporarily unavailable");
            throw error;
          }
          processingText = transcript.fullText;
          storedText = transcript.timestampedText;
        }
        const text = processingText ?? "";
        const filePath = `youtube/${videoId}/transcript.txt`;
        const fileSize = await deps.storage.upload(filePath, Readable.from(Buffer.from(storedText ?? text, "utf8")), "text/plain");
        let metadata: YouTubeMetadata | null = null;
        try {
          metadata = await deps.youtube.fetchMetadata(videoId);
        } catch {
          metadata = null;
        }
        const title = suppliedTitle ?? metadata?.title ?? `YouTube: ${videoId}`;
        const combinedTags = [...new Set([...(metadata?.tags ?? []), ...tags])];
        const created = await deps.repository.create_content({
          content_type: "youtube", title, mime_type: "text/plain", file_size: fileSize, file_path: filePath,
          author: request.keyId ?? null, tags: combinedTags,
          metadata: youtubeMetadataJson(videoId, resourceKey, metadata, clientMetadata),
        });
        const id = contentId(created) || videoId;
        const job = await deps.jobs.submit({ contentId: id, contentText: text, contentType: "youtube", title, resourceKey, notifyAgentId });
        return jsonResponse({ title, content_id: id, content_type: "youtube", job_id: submittedJobId(job) });
      }
      const canonicalUrl = canonicalWebUrl(url);
      const urlHash = createHash("sha256").update(canonicalUrl).digest("hex");
      const resourceKey = `url:${urlHash}`;
      const existing = await deps.repository.find_content_by_resource_key(resourceKey);
      if (existing !== undefined) {
        const title = existing.title ?? canonicalUrl;
        const jobId = await resubmitExistingIngest(deps, existing, resourceKey, title, notifyAgentId);
        return jsonResponse({ content_id: contentId(existing), content_type: existing.content_type, title, job_id: jobId });
      }
      const extracted = await deps.docling.extractMarkdown(url);
      const title = extracted.title ?? canonicalUrl;
      const filePath = `web/${urlHash}/content.md`;
      const fileSize = await deps.storage.upload(filePath, Readable.from(Buffer.from(extracted.markdown, "utf8")), "text/markdown");
      const created = await deps.repository.create_content({
        content_type: "web", title, mime_type: "text/markdown", file_size: fileSize, file_path: filePath,
        author: request.keyId ?? null, tags, metadata: { source_url: url, canonical_url: canonicalUrl, resource_key: resourceKey },
      });
      const id = contentId(created) || urlHash;
      const job = await deps.jobs.submit({ contentId: id, contentText: extracted.markdown, contentType: "web", title, resourceKey, notifyAgentId });
      return jsonResponse({ title, content_id: id, content_type: "web", job_id: submittedJobId(job) });
    },
    jobsList: async (request) => {
      const limit = integerQuery(request.query.limit, "limit", 50, 1, 100);
      const offset = integerQuery(request.query.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
      return jsonResponse(await deps.jobs.list(request.query.content_id, statusFromQuery(request.query.status), limit, offset));
    },
    jobsStats: async () => jsonResponse(await deps.jobs.stats()),
    jobDetail: async (request) => {
      const id = request.params.job_id ?? "";
      const job = await deps.jobs.get(id);
      if (job === undefined) throw new HttpError(404, "Job not found");
      return jsonResponse(request.query.verbose === "true" ? job : {
        job_id: job.job_id, content_id: job.content_id, status: job.status,
        created_at: job.created_at, started_at: job.started_at, finished_at: job.finished_at, stages: job.stages,
      });
    },
    jobCancel: async (request) => {
      const job = await deps.jobs.cancel(request.params.job_id ?? "");
      if (job === undefined) throw new HttpError(404, "Job not found");
      return jsonResponse(job);
    },
    search: async (request) => {
      const body = parseJsonObject(request.body);
      const query = requiredText(body, "query");
      const rawLimit = body.limit;
      if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || typeof rawLimit !== "number")) {
        throw bodyValidationError("limit", "Input should be a valid integer", "int_type");
      }
      return jsonResponse(await deps.search.search(query, rawLimit as number | undefined));
    },
    usage: async (request) => jsonResponse(await getUsage(deps.repository, deps.pricing, toUsageQuery(
      usageDate(request.query.start_date, "start_date"), usageDate(request.query.end_date, "end_date"), request.query.provider, request.query.model,
    ))),
    youtubeChannel: async (request) => {
      const channel = request.query.channel;
      if (channel === undefined || channel === "") throw validationError("channel", "Field required", "missing");
      const limit = integerQuery(request.query.limit, "limit", 50, 1, 500);
      try {
        const response = await deps.youtube.fetchChannelVideosResponse(channel, limit);
        return jsonResponse({
          source: response.source,
          videos: response.videos.map((video) => ({
            video_id: video.videoId,
            title: video.title,
            url: video.url,
            published_at: video.publishedAt,
            duration: video.duration,
            duration_seconds: video.durationSeconds,
            view_count: video.viewCount,
          })),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("No channel found")) throw new HttpError(404, message);
        throw error;
      }
    },
  };
}
