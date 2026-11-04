import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEFAULT_SIGNING_KEY_PATH, loadRequestSigner, type RequestSigner } from "./http-signer";

export * from "./http-signer";
export * from "./archive";
import { ARCHIVE_CHUNK_BYTES, archiveManifestId, type ArchiveChunk, type ArchiveManifest, type ArchiveManifestRecord, type ArchiveListOptions, type ArchiveListResponse, type ArchiveSearchResponse } from "./archive";

export type JsonObject = Record<string, unknown>;
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type OnclaveClientOptions = {
  endpoint: string;
  keyPath?: string;
  signer?: RequestSigner;
  fetchFn?: FetchFn;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export class OnclaveApiError extends Error {
  readonly status: number;
  readonly detail?: string;
  readonly responseBody: string;
  constructor(status: number, detail: string | undefined, responseBody: string) {
    super(`Onclave API request failed (${status})${detail === undefined ? "" : `: ${detail}`}`);
    this.name = "OnclaveApiError";
    this.status = status;
    this.detail = detail;
    this.responseBody = responseBody;
  }
}

const API_PATH = "/api/v1/";
function endpoint(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Onclave endpoint must be a valid http or https URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Onclave endpoint must be an origin or end in /api/v1");
  }
  if (url.pathname === "/" || url.pathname === "/api/v1" || url.pathname === "/api/v1/") url.pathname = API_PATH;
  else throw new Error("Onclave endpoint must be an origin or end in /api/v1");
  return url;
}
function object(value: unknown): value is JsonObject { return value !== null && typeof value === "object" && !Array.isArray(value); }
function query(params: Record<string, string | number | boolean | undefined>): string {
  const values = Object.entries(params).filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined);
  return values.length === 0 ? "" : `?${new URLSearchParams(values.map(([key, value]) => [key, String(value)] as [string, string]))}`;
}

export type ContentListItem = { id: string; content_type: string; title: string | null; status: string | null; created_at: string; chunk_count: number; tags: string[]; metadata: JsonObject };
export type ContentListResponse = { items: ContentListItem[]; total: number; offset: number; limit: number };
export type TranscriptDownloadVariant = "original" | "analysis";
export type TranscriptDownloadOptions = { variant?: TranscriptDownloadVariant; signal?: AbortSignal };
export type TranscriptFilteringSummary = {
  outcome: string;
  reason: string;
  lookup_state: string;
  timing: "available" | "unavailable";
  retained_segment_count: number | null;
  excluded_segment_count: number | null;
};
export type ContentResponse = JsonObject & {
  id: string;
  content_type: string;
  summary?: string | null;
  structured_summary?: JsonObject;
  outline?: JsonObject;
  summary_coverage?: JsonObject;
  filtering?: TranscriptFilteringSummary | null;
};
export type IngestResponse = { content_id: string; content_type: string; title: string; job_id: string };
export type JobStatus = "pending" | "processing" | "completed" | "failed" | "cancelled" | string;
export type JobResponse = JsonObject & { job_id: string; content_id: string; status: JobStatus };
export type JobListResponse = { jobs: JobResponse[]; total: number };
export type SearchResponse = { results: JsonObject[]; total: number };
export type ChannelResponse = { source: string; videos: JsonObject[] };
export const IMPROVEMENT_KINDS = ["feedback", "failure", "knowledge", "analysis", "classification", "review", "note"] as const;
export type ImprovementKind = typeof IMPROVEMENT_KINDS[number];
export type ImprovementDraft = { id: string; kind: ImprovementKind; body: string; project?: string; source_ids?: string[]; source_paths?: string[]; provenance?: JsonObject };
export type ImprovementRecord = { id: string; kind: ImprovementKind; body: string; project: string | null; source_ids: string[]; source_paths: string[]; provenance: JsonObject; revision: number; created_at?: string; updated_at?: string };
export type ImprovementListResponse = { items: ImprovementRecord[]; total: number; limit: number; offset: number };

export type AuthenticatedS3ClientOptions = {
  endpoint: string;
  bucket: string;
  region: string;
  accessKey: string;
  secretKey: string;
  fetchFn?: FetchFn;
};

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeObjectPath(value: string): string {
  // WHATWG URL parsing treats these two segments as navigation, so encode the
  // dots before constructing the request URL. This keeps the S3 key and the
  // SigV4 canonical URI identical to the bytes sent on the wire.
  return value.split("/").map((part) => part === "." || part === ".." ? part.replaceAll(".", "%2E") : encodePathSegment(part)).join("/");
}

function transcriptDownloadOptions(value: AbortSignal | TranscriptDownloadOptions | undefined): TranscriptDownloadOptions {
  if (value === undefined) return {};
  return value instanceof AbortSignal ? { signal: value } : value;
}

function s3Endpoint(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("S3 endpoint must be a valid https URL"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("S3 endpoint must be an https origin without credentials, query, or fragment");
  parsed.pathname = parsed.pathname.replace(/\/$/, "");
  return parsed;
}

function hmac(key: string | Buffer, value: string): Buffer { return createHmac("sha256", key).update(value, "utf8").digest(); }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** Minimal path-style SigV4 GET client for the workstation S3 API. */
export class AuthenticatedS3Client {
  readonly bucket: string;
  private readonly endpoint: URL;
  private readonly options: AuthenticatedS3ClientOptions;
  private readonly fetchFn: FetchFn;

  constructor(options: AuthenticatedS3ClientOptions) {
    this.endpoint = s3Endpoint(options.endpoint);
    if (options.bucket.trim() === "" || options.region.trim() === "" || options.accessKey === "" || options.secretKey === "") throw new Error("S3 credentials and bucket are required");
    this.bucket = options.bucket;
    this.options = options;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  private objectPath(objectKey: string): string {
    if (objectKey === "" || objectKey.startsWith("/") || objectKey.includes("\\")) throw new Error("S3 object key is invalid");
    return `/${encodePathSegment(this.bucket)}/${encodeObjectPath(objectKey)}`;
  }

  objectUrl(objectKey: string): string {
    // Do not pass this path through `new URL`: its dot-segment removal would
    // change valid S3 keys such as `.` and `..`.
    return `${this.endpoint.toString().replace(/\/$/, "")}${this.objectPath(objectKey)}`;
  }

  async getObject(objectKey: string, signal?: AbortSignal): Promise<Response> {
    const path = `${this.endpoint.pathname.replace(/\/$/, "")}${this.objectPath(objectKey)}`;
    const url = `${this.endpoint.toString().replace(/\/$/, "")}${this.objectPath(objectKey)}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const date = amzDate.slice(0, 8);
    const payloadHash = hash("");
    const canonicalHeaders = `host:${this.endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = ["GET", path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.options.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, hash(canonicalRequest)].join("\n");
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.options.secretKey}`, date), this.options.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
    const authorization = `AWS4-HMAC-SHA256 Credential=${this.options.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return this.fetchFn(url, { method: "GET", headers: { host: this.endpoint.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate, authorization }, ...(signal === undefined ? {} : { signal }) });
  }
}

export function createAuthenticatedS3Client(options: AuthenticatedS3ClientOptions): AuthenticatedS3Client { return new AuthenticatedS3Client(options); }
export type ReindexResponse = { content_id: string; status: "completed"; chunk_count: number; model: string };
export type AnnotationResponse = JsonObject & { id: string; parent_content_id: string; text: string };

export function resolveEndpoint(explicit: string | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  const value = explicit ?? environment.ONCLAVE_API_BASE;
  if (value === undefined || value.trim() === "") throw new Error("ONCLAVE_API_BASE is required");
  return endpoint(value.trim()).toString();
}

export async function createOnclaveClient(options: OnclaveClientOptions): Promise<OnclaveClient> {
  const signer = options.signer ?? await loadRequestSigner(options.keyPath ?? DEFAULT_SIGNING_KEY_PATH);
  return new OnclaveClient({ ...options, signer });
}

export class OnclaveClient {
  readonly apiBase: string;
  private readonly base: URL;
  private readonly signerPromise: Promise<RequestSigner>;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly signal?: AbortSignal;
  constructor(options: OnclaveClientOptions) {
    this.base = endpoint(options.endpoint);
    this.apiBase = this.base.toString().replace(/\/$/, "");
    this.signerPromise = options.signer ? Promise.resolve(options.signer) : loadRequestSigner(options.keyPath ?? DEFAULT_SIGNING_KEY_PATH);
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("Onclave timeoutMs must be a positive safe integer");
    this.signal = options.signal;
  }
  static async fromConfig(endpointValue: string, keyPath = DEFAULT_SIGNING_KEY_PATH, options: Omit<OnclaveClientOptions, "endpoint" | "keyPath"> = {}): Promise<OnclaveClient> {
    await readFile(keyPath); // Fail configuration early, before the first network request.
    return new OnclaveClient({ ...options, endpoint: endpointValue, keyPath });
  }
  ingest(payload: { url: string; transcript_text?: string; transcript_format?: "plain"; metadata?: JsonObject; title?: string; notify_agent_id?: string }, options?: { tags?: string[]; signal?: AbortSignal }): Promise<IngestResponse> { return this.json("POST", `/ingest${query({ tags: options?.tags?.join(",") })}`, payload, options?.signal); }
  listContent(options: { offset?: number; limit?: number; content_type?: string; tags?: string[]; exclude_tags?: string[] } = {}, signal?: AbortSignal): Promise<ContentListResponse> { return this.json("GET", `/content${query({ ...options, tags: options.tags?.join(","), exclude_tags: options.exclude_tags?.join(",") })}`, undefined, signal); }
  findByVideoId(videoId: string, signal?: AbortSignal): Promise<ContentListItem | undefined> { return this.findAll({ content_type: "youtube" }, signal).then((items) => items.find((item) => item.metadata.video_id === videoId)); }
  async findAll(options: Parameters<OnclaveClient["listContent"]>[0] = {}, signal?: AbortSignal): Promise<ContentListItem[]> { const result: ContentListItem[] = []; let offset = 0; do { const page = await this.listContent({ ...options, offset, limit: options.limit ?? 100 }, signal); result.push(...page.items); offset += page.items.length; if (page.items.length === 0 || offset >= page.total) break; } while (true); return result; }
  getContent(contentId: string, signal?: AbortSignal): Promise<ContentResponse> { return this.json("GET", `/content/${encodeURIComponent(contentId)}`, undefined, signal); }
  /** Returns the authenticated raw download. The historical default is the original variant. */
  downloadContent(contentId: string, signal?: AbortSignal): Promise<Response>;
  downloadContent(contentId: string, options?: TranscriptDownloadOptions): Promise<Response>;
  downloadContent(contentId: string, signalOrOptions?: AbortSignal | TranscriptDownloadOptions): Promise<Response> {
    const options = transcriptDownloadOptions(signalOrOptions);
    return this.request("GET", `/content/${encodeURIComponent(contentId)}/download${query({ variant: options.variant })}`, undefined, options.signal);
  }
  /** Reads a transcript as text. Analysis must be requested explicitly. */
  getTranscript(contentId: string, signal?: AbortSignal): Promise<string>;
  getTranscript(contentId: string, options?: TranscriptDownloadOptions): Promise<string>;
  async getTranscript(contentId: string, signalOrOptions?: AbortSignal | TranscriptDownloadOptions): Promise<string> {
    const options = transcriptDownloadOptions(signalOrOptions);
    return this.text("GET", `/content/${encodeURIComponent(contentId)}/download${query({ variant: options.variant })}`, undefined, options.signal);
  }
  search(search: { query: string; limit?: number }, signal?: AbortSignal): Promise<SearchResponse> { return this.json("POST", "/search", search, signal); }
  channel(channel: string, limit?: number, signal?: AbortSignal): Promise<ChannelResponse> { return this.json("GET", `/youtube/channel${query({ channel, limit })}`, undefined, signal); }
  jobs(options: { content_id?: string; status?: string; offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<JobListResponse> { return this.json("GET", `/jobs${query(options)}`, undefined, signal); }
  job(jobId: string, verbose = false, signal?: AbortSignal): Promise<JobResponse> { return this.json("GET", `/jobs/${encodeURIComponent(jobId)}${query({ verbose: verbose ? "true" : undefined })}`, undefined, signal); }
  jobStats(signal?: AbortSignal): Promise<JsonObject> { return this.json("GET", "/jobs/stats", undefined, signal); }
  cancelJob(jobId: string, signal?: AbortSignal): Promise<JobResponse> { return this.json("POST", `/jobs/${encodeURIComponent(jobId)}/cancel`, undefined, signal); }
  reprocess(contentId: string, force = false, signalOrOptions?: AbortSignal | { signal?: AbortSignal; notify_agent_id?: string; notifyAgentId?: string }, notifyAgentId?: string): Promise<JsonObject> {
    const options = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : signalOrOptions;
    const signal = options?.signal;
    const notificationAgent = notifyAgentId ?? options?.notify_agent_id ?? options?.notifyAgentId;
    return this.json("POST", `/content/${encodeURIComponent(contentId)}/reprocess${query({ force: force ? "true" : undefined, notify_agent_id: notificationAgent })}`, undefined, signal);
  }
  reindexEmbeddings(contentId: string, signal?: AbortSignal): Promise<ReindexResponse> { return this.json("POST", `/content/${encodeURIComponent(contentId)}/reindex-embeddings`, undefined, signal); }
  async uploadArchiveChunk(bytes: Uint8Array, signal?: AbortSignal): Promise<ArchiveChunk> {
    if (bytes.byteLength < 1 || bytes.byteLength > ARCHIVE_CHUNK_BYTES) throw new Error("Archive chunk must contain 1 to 1048576 bytes");
    const data = Buffer.from(bytes);
    const sha256 = createHash("sha256").update(data).digest("hex");
    return this.json("POST", "/archive/chunks", { sha256, data_base64: data.toString("base64") }, signal);
  }
  async commitArchiveManifest(manifest: ArchiveManifest, signal?: AbortSignal): Promise<ArchiveManifestRecord> {
    if (archiveManifestId(manifest) !== manifest.id) throw new Error("Archive manifest hash mismatch");
    return this.json("POST", "/archive/manifests", manifest, signal);
  }
  listArchiveManifests(options: ArchiveListOptions = {}, signal?: AbortSignal): Promise<ArchiveListResponse> { return this.json("GET", `/archive/manifests${query(options)}`, undefined, signal); }
  getArchiveManifest(id: string, signal?: AbortSignal): Promise<ArchiveManifestRecord> { return this.json("GET", `/archive/manifests/${encodeURIComponent(id)}`, undefined, signal); }
  async downloadArchive(id: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.request("GET", `/archive/manifests/${encodeURIComponent(id)}/download${query(options)}`, undefined, signal);
    return Buffer.from(await response.arrayBuffer());
  }
  searchArchive(id: string, options: { q: string; offset?: number }, signal?: AbortSignal): Promise<ArchiveSearchResponse> { return this.json("GET", `/archive/manifests/${encodeURIComponent(id)}/search${query(options)}`, undefined, signal); }
  createImprovement(draft: ImprovementDraft, signal?: AbortSignal): Promise<ImprovementRecord> { return this.json("POST", "/improvements", draft, signal); }
  getImprovement(id: string, signal?: AbortSignal): Promise<ImprovementRecord> { return this.json("GET", `/improvements/${encodeURIComponent(id)}`, undefined, signal); }
  listImprovements(options: { q?: string; kind?: ImprovementKind; project?: string; limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<ImprovementListResponse> { return this.json("GET", `/improvements${query(options)}`, undefined, signal); }
  updateImprovement(id: string, draft: Omit<ImprovementDraft, "id" | "provenance"> & { expected_revision: number }, signal?: AbortSignal): Promise<ImprovementRecord> { return this.json("PATCH", `/improvements/${encodeURIComponent(id)}`, draft, signal); }
  createAnnotation(contentId: string, annotation: { text: string; title?: string; source_type?: string; tags?: string[] }, signal?: AbortSignal): Promise<AnnotationResponse> { return this.json("POST", `/content/${encodeURIComponent(contentId)}/annotations`, annotation, signal); }
  listAnnotations(contentId: string, signal?: AbortSignal): Promise<AnnotationResponse[]> { return this.json("GET", `/content/${encodeURIComponent(contentId)}/annotations`, undefined, signal); }
  private async json<T extends JsonObject | JsonObject[] = JsonObject>(method: string, path: string, body: object | undefined, signal?: AbortSignal): Promise<T> { const response = await this.request(method, path, body, signal); const parsed: unknown = await response.json(); if (!object(parsed) && !Array.isArray(parsed)) throw new Error("Onclave API returned invalid JSON"); return parsed as T; }
  private async text(method: string, path: string, body: object | undefined, signal?: AbortSignal): Promise<string> { return (await this.request(method, path, body, signal)).text(); }
  private async request(method: string, path: string, body: object | undefined, signal?: AbortSignal): Promise<Response> {
    const combined = signal && this.signal ? AbortSignal.any([signal, this.signal]) : signal ?? this.signal;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Onclave request deadline exceeded")), this.timeoutMs);
    const finalSignal = combined ? AbortSignal.any([combined, controller.signal]) : controller.signal;
    finalSignal.throwIfAborted(); const url = new URL(path.replace(/^\//, ""), this.base); const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body)); const signer = await this.signerPromise;
    try { const response = await this.fetchFn(url.toString(), { method, headers: { ...(bytes ? { "content-type": "application/json" } : {}), ...signer.signRequest(method, `${url.pathname}${url.search}`, url.host, bytes) }, ...(bytes ? { body: bytes } : {}), signal: finalSignal }); if (!response.ok) { const bodyText = await response.text(); let detail: string | undefined; try { const parsed: unknown = JSON.parse(bodyText); if (object(parsed)) { if (typeof parsed.detail === "string") detail = parsed.detail; else if (typeof parsed.error === "string") detail = `${parsed.error}${typeof parsed.expected_revision === "number" ? ` (expected revision ${parsed.expected_revision}` : ""}${typeof parsed.current_revision === "number" ? `${typeof parsed.expected_revision === "number" ? ", " : " ("}current revision ${parsed.current_revision}` : ""}${typeof parsed.expected_revision === "number" || typeof parsed.current_revision === "number" ? ")" : ""}`; } } catch { /* retain raw body */ } throw new OnclaveApiError(response.status, detail, bodyText); }
      return response;
    } finally { clearTimeout(timer); }
  }
}
export { DEFAULT_SIGNING_KEY_PATH };
