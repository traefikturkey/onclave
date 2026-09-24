import { createHash, createHmac } from "node:crypto";
import { DEFAULT_ANALYSIS_INPUT_BUDGET_TOKENS, DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS, estimateAnalysisTokens, planAdjacentReduction, planAnalysisChunks, type AnalysisNote, type AnalysisSourceSegment } from "./analysis-budget";
import type { VaultConfig } from "./config";
import { emitVaultEvent, type JobDeliveryIntent, type VaultEventSink } from "./durability";
import { legacySummaryFromCanonical, type CanonicalSummary, type VersionedOutline } from "./transcript-analysis";
import type {
  ChunkModel,
  ContentEntityEdge,
  EntityModel,
  EntityType,
  ExtractedEntity,
  JsonObject,
  JsonValue,
  PipelineJob,
  PreDetectedValidation,
  StructuredSummary,
  UnifiedResult,
} from "./models";
import { EdgeType, EntityType as EntityTypes } from "./models";
import { PIPELINE_STAGES, type PipelineStage, type PipelineStageStatus } from "./job-stages";
import type { LlmProvider } from "./llm-providers";

const VALID_TIERS = new Set(["S", "A", "B", "C", "D"]);
const LABEL_PATTERN = /^[a-z][a-z0-9-]*$/;
const CALLBACK_NAMESPACE = "a1b2c3d4e5f67890abcdef1234567890";
const INTERMEDIATE_ANALYSIS_OUTPUT_TOKENS = 1_000;

export const UNIFIED_PROMPT_TEMPLATE = `You are a content analyst. Evaluate the content and provide classification ratings, tags, and entity extraction in a single response.

CONTENT TYPE: {content_type}
CONTENT TITLE: {title}

## EXISTING TAGS (prefer these over creating new ones)
{existing_tags}

## PRE-DETECTED ENTITIES (already found via URL/keyword matching)
{pre_detected_entities_json}

## EXISTING TOPICS (strongly prefer these)
{existing_topics}

## TAG CO-OCCURRENCE PATTERNS
{tag_cooccurrence}

## QUALITY DISTRIBUTION (calibrate your ratings)
Current distribution: {tier_distribution}
Aim for a balanced distribution. Most content should be B or C tier.

## KNOWN ALIASES
{known_aliases}

## RULES

### Tags
- Assign up to 10 tags from existing tags above
- You may create up to {max_new_tags} NEW tags if needed (lowercase, hyphenated)
- Tags must be single lowercase words or hyphenated (e.g. "kubernetes", "home-lab")

### Quality Rating
- Assign a quality tier: S (exceptional), A (great), B (good), C (mediocre), D (poor)
- Assign a quality score from 1-100 where 50 = average, 80+ = exceptional, <30 = low value
- Provide brief explanations (2-3 bullet points each)

### Summary
- Generate the legacy scalar summary as a 2-3 sentence overview followed by 3-5 bullet points of main topics
- Also generate structured_summary using version 1 with a concise overview and 3-5 key points

### Topics
- Extract 3-7 hierarchical topics
- Format: "Parent > Child > Grandchild" (e.g., "AI > LLMs > RAG")
- PREFER existing topics over creating new ones

### Pre-detected Validations
- For each pre-detected entity, confirm edge_type:
  discusses, mentions, uses, cites, demonstrates

### Additional Entities
- Only extract repos/tools/papers NOT in the pre-detected list
- Must be substantively discussed, not just name-dropped

<CONTENT>
{content_text}
</CONTENT>

Respond ONLY with valid JSON (no markdown, no code blocks):
{
  "tags": ["existing-tag-1", "existing-tag-2"],
  "new_tags": ["genuinely-new-tag"],
  "tier": "B",
  "tier_explanation": ["Reason 1", "Reason 2"],
  "quality_score": 55,
  "score_explanation": ["Reason 1", "Reason 2"],
  "summary": "2-3 sentence overview.\\n\\n- Bullet 1\\n- Bullet 2",
  "structured_summary": {
    "version": 1,
    "overview": "2-3 sentence overview.",
    "key_points": ["Bullet 1", "Bullet 2", "Bullet 3"]
  },
  "topics": [
    {"name": "AI > LLMs > RAG", "confidence": "high", "edge_type": "discusses"}
  ],
  "pre_detected_validations": [
    {"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": true}
  ],
  "additional_entities": [
    {"type": "repo", "name": "FAISS", "confidence": "medium", "edge_type": "mentions"}
  ]
}`;

export class PipelineStageError extends Error {
  readonly stage: string;
  readonly code: string;

  constructor(stage: string, code: string, message: string) {
    super(`[${stage}] ${code}: ${message}`);
    this.stage = stage;
    this.code = code;
  }
}

export type PipelineConfig = Pick<
  VaultConfig,
  | "unifiedPipelineEnabled"
  | "unifiedPipelineMaxConcurrency"
  | "unifiedPipelineMaxNewTags"
  | "entityMaxTopicsPerContent"
  | "entityMinConfidence"
  | "callbackUrl"
  | "callbackSecret"
> & {
  /** Optional for direct/test callers; production config supplies the tuned value. */
  unifiedPipelineInputBudget?: VaultConfig["unifiedPipelineInputBudget"];
  unifiedPipelineProvider?: VaultConfig["unifiedPipelineProvider"];
  onEvent?: VaultEventSink;
};

export type PreDetectedEntity = {
  id?: string;
  normalized_name: string;
  entity_type: EntityType;
  name: string;
};

export type PipelineRequest = {
  contentId: string;
  contentText: string;
  contentType: string;
  title: string;
  jobId?: string;
  claimToken?: string;
  preDetected?: readonly PreDetectedEntity[];
  existingTopics?: readonly string[];
  pipelineVersion: string;
  /** Optional for callers that predate whole-video analysis budgeting. */
  analysisSegments?: readonly AnalysisSourceSegment[];
};

export type PipelineStorage = {
  transition_pipeline_job_stage?(jobId: string, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined], errors: readonly [string | null | undefined, string | null | undefined], expectedStatuses: readonly PipelineStageStatus[], claimToken?: string): Promise<unknown>;
  list_tags_with_counts(): Promise<readonly Record<string, unknown>[]>;
  get_topic_hierarchy(): Promise<readonly EntityModel[]>;
  get_tag_cooccurrence(): Promise<Record<string, string[]>>;
  get_tier_distribution(): Promise<Record<string, number>>;
  get_tag_aliases(): Promise<Record<string, string>>;
  record_tag_alias(variant: string, canonical: string): Promise<void>;
  find_or_create_entity(
    name: string,
    entityType: EntityType,
    values?: Omit<Partial<EntityModel>, "name" | "entity_type" | "normalized_name">,
  ): Promise<readonly [EntityModel, boolean]>;
  complete_content_processing(
    contentId: string,
    result: JsonObject,
    pipelineVersion: string,
    chunks: ChunkModel[],
    relationships: ContentEntityEdge[],
    finalization?: PipelineFinalizationOptions,
  ): Promise<boolean | void>;
};

export type ChunkingService = {
  chunkText(text: string): string[];
};

export type PipelineEmbeddingService = {
  embedBatch(texts: readonly string[]): Promise<number[][]>;
};

export type CallbackFetcher = (url: string, init?: RequestInit) => Promise<Response>;

type PromptContext = {
  existingTags: string[];
  promptTopics: string[];
  tagCooccurrence: Record<string, string[]>;
  tierDistribution: Record<string, number>;
  knownAliases: Record<string, string>;
};

type ContextualLlmProvider = LlmProvider & {
  withContext?: (context: string) => LlmProvider;
};

export type PipelineRunResult = {
  result: UnifiedResult;
  resultJson: JsonObject;
};

export type PipelineEntityCandidate = {
  referenceId: string;
  name: string;
  entityType: EntityType;
  hierarchy: string[] | null;
};

export type PipelineFinalizationOptions = {
  aliases: readonly (readonly [string, string])[];
  entities: readonly PipelineEntityCandidate[];
  jobId?: string;
  claimToken?: string;
  persistStageCompletedAt: Date;
};

type ProcessedPipelineRunResult = PipelineRunResult & {
  aliasMappings: [string, string][];
};

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return record(value) as JsonObject | undefined;
}

function asciiJson(value: string): string {
  return value.replace(/[^\x00-\x7f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function jsonQuote(value: string): string {
  return asciiJson(JSON.stringify(value));
}

function jsonString(value: JsonValue): string {
  if (typeof value === "string") return jsonQuote(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonString).join(",")}]`;
  return `{${Object.keys(value).sort().flatMap((key) => {
    const item = value[key];
    return item === undefined ? [] : [`${jsonQuote(key)}:${jsonString(item)}`];
  }).join(",")}}`;
}

function normalizedName(value: string): string {
  return value.toLowerCase().replaceAll(" ", "").replaceAll("-", "").replaceAll("_", "");
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex] ?? 0;
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      previous[rightIndex] = Math.min((previous[rightIndex - 1] ?? 0) + 1, above + 1, diagonal + cost);
      diagonal = above;
    }
  }
  return previous[right.length] ?? 0;
}

function dedupLabel(candidate: string, labels: readonly string[]): string | undefined {
  const normalizedCandidate = normalizedName(candidate);
  return labels.find((label) => editDistance(normalizedCandidate, normalizedName(label)) <= 2);
}

function validLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((label): label is string => typeof label === "string" && LABEL_PATTERN.test(label)) : [];
}

function confidenceValue(value: unknown): number {
  if (typeof value !== "string") return 0.6;
  return ({ high: 0.9, medium: 0.7, low: 0.5 } as Record<string, number>)[value.toLowerCase()] ?? 0.6;
}

function edgeType(value: unknown): EdgeType {
  if (typeof value !== "string") return EdgeType.MENTIONS;
  return ({ discusses: EdgeType.DISCUSSES, mentions: EdgeType.MENTIONS, cites: EdgeType.CITES, uses: EdgeType.USES, demonstrates: EdgeType.DEMONSTRATES } as Record<string, EdgeType>)[value.toLowerCase()] ?? EdgeType.MENTIONS;
}

function entityType(value: unknown): EntityType {
  if (typeof value !== "string") return EntityTypes.TOPIC;
  return ({ topic: EntityTypes.TOPIC, repo: EntityTypes.REPO, paper: EntityTypes.PAPER, tool: EntityTypes.TOOL, person: EntityTypes.PERSON } as Record<string, EntityType>)[value.toLowerCase()] ?? EntityTypes.TOPIC;
}

function explanations(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string | number | boolean => Boolean(item) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")).map(String) : [];
}

function structuredSummary(value: unknown): StructuredSummary | undefined {
  const summary = record(value);
  if (summary === undefined || (summary.version !== 1 && summary.version !== "1") || typeof summary.overview !== "string" || !Array.isArray(summary.key_points)) return undefined;
  const overview = summary.overview.trim();
  const keyPoints = summary.key_points
    .filter((point): point is string => typeof point === "string")
    .map((point) => point.trim())
    .filter((point) => point !== "");
  if (overview === "" || keyPoints.length === 0) return undefined;
  return { version: 1, overview, key_points: keyPoints };
}

function extractJson(response: string): JsonObject | undefined {
  const cleaned = response.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  const candidates = [
    cleaned,
    /```json\s*\n?([\s\S]*?)\n?```/.exec(cleaned)?.[1],
    /```\s*\n?([\s\S]*?)\n?```/.exec(cleaned)?.[1],
    /\{[\s\S]*\}/.exec(cleaned)?.[0],
  ];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(candidate);
      const output = jsonObject(parsed);
      if (output !== undefined) return output;
    } catch {
      continue;
    }
  }
  return undefined;
}

const YOUTUBE_SINGLE_PROMPT_TEMPLATE = `You are a content analyst. Analyze the complete retained transcript below. Do not infer facts from omitted material. Return classification, entity extraction, one canonical structured summary, and an ordered grounded outline.

CONTENT TYPE: youtube
CONTENT TITLE: {title}

## EXISTING TAGS (prefer these over creating new ones)
{existing_tags}

## PRE-DETECTED ENTITIES (already found via URL/keyword matching)
{pre_detected_entities_json}

## EXISTING TOPICS (strongly prefer these)
{existing_topics}

## TAG CO-OCCURRENCE PATTERNS
{tag_cooccurrence}

## QUALITY DISTRIBUTION (calibrate your ratings)
Current distribution: {tier_distribution}
Aim for a balanced distribution. Most content should be B or C tier.

## KNOWN ALIASES
{known_aliases}

## RULES
- Assign up to 10 tags from existing tags above.
- You may create up to {max_new_tags} NEW lowercase hyphenated tags if needed.
- Assign a quality tier and score with brief explanations.
- Extract 3-7 hierarchical topics and validate pre-detected entities.
- Extract additional repos/tools/papers only when substantively discussed.
- The structured_summary is the only authored summary. It must use version 1, a concise overview, and non-empty key_points.
- The outline must use version 1. Each section needs a heading and description. Ground sections with source segment IDs from the source index when possible. Do not invent source IDs or timestamps.
- Distinguish claims from demonstrated evidence, and include mechanisms, results, and limitations when present.

## SOURCE INDEX
{source_index}

<RETAINED TRANSCRIPT>
{content_text}
</RETAINED TRANSCRIPT>

Respond ONLY with valid JSON (no markdown or explanation):
{
  "tags": ["existing-tag-1"],
  "new_tags": ["genuinely-new-tag"],
  "tier": "B",
  "tier_explanation": ["Reason"],
  "quality_score": 55,
  "score_explanation": ["Reason"],
  "structured_summary": {"version": 1, "overview": "2-3 sentence overview.", "key_points": ["Mechanism", "Result", "Limitation"]},
  "outline": {"version": 1, "sections": [{"heading": "Section", "description": "What happens.", "source": {"segment_ids": ["segment-1"]}}]},
  "topics": [{"name": "AI > LLMs", "confidence": "high", "edge_type": "discusses"}],
  "pre_detected_validations": [{"entity_id": "entity:langchain", "edge_type": "uses", "confirmed": true}],
  "additional_entities": [{"type": "tool", "name": "Tool", "confidence": "medium", "edge_type": "mentions"}]
}`;

const YOUTUBE_MAP_PROMPT = `Analyze this retained transcript unit in its source order. Return only JSON. Record concrete mechanisms, demonstrations, reported results, limitations, and relevant entities. Do not infer facts outside this unit. Preserve the supplied source segment IDs in the note.

UNIT SOURCE INDEX:
{source_index}

<RETAINED UNIT>
{content_text}
</RETAINED UNIT>

{"note":{"text":"ordered factual analysis of this unit","source_segment_ids":["segment-1"]}}`;

const YOUTUBE_REDUCTION_PROMPT = `Combine these adjacent ordered analysis notes into one faithful ordered note. Do not add facts, discard later notes, or change source IDs. Return only JSON with a note object containing concise factual text and the union of source_segment_ids.

{notes}

{"note":{"text":"combined ordered analysis","source_segment_ids":["segment-1","segment-2"]}}`;

const YOUTUBE_SYNTHESIS_PROMPT = `Synthesize the complete ordered analysis notes below into the canonical JSON schema. Every retained source unit is represented by at least one source ID. Use only those notes and source IDs. Return one canonical structured_summary (version 1) and an ordered version 1 outline grounded in the source index. Do not return an independently authored scalar summary. Do not invent timestamps or source IDs. Also preserve classification, tags, topics, validations, and additional entities.

CONTENT TITLE: {title}

## EXISTING TAGS
{existing_tags}
## EXISTING TOPICS
{existing_topics}
## PRE-DETECTED ENTITIES
{pre_detected_entities_json}
## TAG CO-OCCURRENCE PATTERNS
{tag_cooccurrence}
## QUALITY DISTRIBUTION
{tier_distribution}
## KNOWN ALIASES
{known_aliases}
## SOURCE INDEX
{source_index}

## ORDERED ANALYSIS NOTES
{notes}

Respond ONLY with valid JSON (no markdown or explanation):
{
  "tags": [], "new_tags": [], "tier": "B", "tier_explanation": [], "quality_score": 50, "score_explanation": [],
  "structured_summary": {"version": 1, "overview": "overview", "key_points": ["mechanism", "result", "limitation"]},
  "outline": {"version": 1, "sections": [{"heading": "Section", "description": "Description", "source": {"segment_ids": ["segment-1"]}}]},
  "topics": [{"name": "Topic", "confidence": "high", "edge_type": "discusses"}],
  "pre_detected_validations": [], "additional_entities": []
}`;

type YouTubeAnalysisContext = {
  segments: AnalysisSourceSegment[];
  sourceIndex: string;
  sourceRangeCount: number;
  sourceChunkCount: number;
  generationMethod: "single_call" | "map_reduce";
};

type ParsedAnalysisNote = AnalysisNote;

function sourceText(segments: readonly AnalysisSourceSegment[]): string {
  return segments.map((segment) => segment.text).join("\n\n");
}

function sourceIndex(segments: readonly AnalysisSourceSegment[]): string {
  return segments.map((segment) => {
    const timing = segment.start_seconds === undefined || segment.duration_seconds === undefined
      ? "timing unavailable"
      : `start=${segment.start_seconds}s end=${segment.start_seconds + segment.duration_seconds}s`;
    return `- ${segment.source_segment_id}: ${timing}`;
  }).join("\n");
}

function sourceRangeCount(segments: readonly AnalysisSourceSegment[]): number {
  let count = 0;
  let previousEnd: number | undefined;
  for (const segment of segments) {
    if (segment.start_seconds === undefined || segment.duration_seconds === undefined) continue;
    const end = segment.start_seconds + segment.duration_seconds;
    if (previousEnd === undefined || segment.start_seconds > previousEnd + 1) count += 1;
    previousEnd = Math.max(previousEnd ?? end, end);
  }
  return count;
}

function analysisSegments(request: PipelineRequest): AnalysisSourceSegment[] {
  if (request.analysisSegments !== undefined) return request.analysisSegments.filter((segment) => segment.text.trim() !== "").map((segment) => ({ ...segment }));
  if (request.contentText.trim() === "") return [];
  return [{ source_segment_id: "analysis-1", text: request.contentText }];
}

function parseAnalysisNote(data: JsonObject | undefined, sourceSegmentIds: readonly string[]): ParsedAnalysisNote | undefined {
  const item = data?.note !== undefined ? record(data.note) : data;
  if (item === undefined) return undefined;
  const text = typeof item.text === "string" ? item.text.trim() : typeof item.analysis === "string" ? item.analysis.trim() : typeof item.summary === "string" ? item.summary.trim() : "";
  if (text === "") return undefined;
  return { text, source_segment_ids: [...sourceSegmentIds] };
}

function sourceEnd(segment: AnalysisSourceSegment): number | undefined {
  return segment.start_seconds === undefined || segment.duration_seconds === undefined ? undefined : segment.start_seconds + segment.duration_seconds;
}

function parseGroundedOutline(value: unknown, segments: readonly AnalysisSourceSegment[]): VersionedOutline | undefined {
  const item = record(value);
  if (item === undefined || (item.version !== 1 && item.version !== "1") || !Array.isArray(item.sections)) return undefined;
  const byId = new Map(segments.map((segment, index) => [segment.source_segment_id, { segment, index }]));
  const sections = item.sections.flatMap((rawSection) => {
    const section = record(rawSection);
    const heading = typeof section?.heading === "string" ? section.heading.trim() : "";
    const description = typeof section?.description === "string" ? section.description.trim() : "";
    if (heading === "" || description === "") return [];
    const rawSource = record(section?.source);
    const ids = (Array.isArray(rawSource?.segment_ids) ? rawSource.segment_ids : Array.isArray(rawSource?.source_segment_ids) ? rawSource.source_segment_ids : [])
      .filter((id): id is string => typeof id === "string" && byId.has(id));
    const orderedIds = [...new Set(ids)].sort((left, right) => (byId.get(left)?.index ?? 0) - (byId.get(right)?.index ?? 0));
    if (orderedIds.length === 0) return [];
    const timed = orderedIds.map((id) => byId.get(id)?.segment).filter((segment): segment is AnalysisSourceSegment => segment !== undefined && segment.start_seconds !== undefined && segment.duration_seconds !== undefined);
    const start = timed.length === orderedIds.length ? Math.min(...timed.map((segment) => segment.start_seconds as number)) : undefined;
    const end = timed.length === orderedIds.length ? Math.max(...timed.map((segment) => sourceEnd(segment) as number)) : undefined;
    return [{ heading, description, source: {
      segment_ids: orderedIds,
      ...(start === undefined || end === undefined ? {} : { start_seconds: start, end_seconds: end }),
    } }];
  });
  return { version: 1, sections };
}

function uuidFromBytes(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function callbackEventId(jobId: string): string {
  const namespace = Buffer.from(CALLBACK_NAMESPACE, "hex");
  const digest = createHash("sha1").update(namespace).update(jobId, "utf8").digest().subarray(0, 16);
  digest[6] = (digest[6] ?? 0) & 0x0f | 0x50;
  digest[8] = (digest[8] ?? 0) & 0x3f | 0x80;
  return uuidFromBytes(digest);
}

function callbackPayload(job: PipelineJob, result: JsonObject | undefined): JsonObject {
  const payload: JsonObject = {
    schema_version: "1",
    event_id: callbackEventId(job.id ?? ""),
    job_id: job.id ?? null,
    content_id: job.content_id,
    resource_key: job.resource_key,
    status: job.status ?? "pending",
    pipeline_version: job.pipeline_version ?? "",
  };
  if (result !== undefined) payload.result = result;
  if (job.error_code !== undefined && job.error_code !== null) payload.error_code = job.error_code;
  if (job.error_message !== undefined && job.error_message !== null) payload.error_message = job.error_message;
  return payload;
}

class AsyncSemaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(maxConcurrency: number) {
    this.available = maxConcurrency;
  }

  async acquire(): Promise<() => void> {
    if (this.available === 0) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.available -= 1;
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      this.available += 1;
      this.waiters.shift()?.();
    };
  }
}

export class UnifiedPipeline {
  private readonly semaphore: AsyncSemaphore;
  private readonly fetcher: CallbackFetcher;

  constructor(
    private readonly llm: ContextualLlmProvider,
    private readonly storage: PipelineStorage,
    private readonly config: PipelineConfig,
    private readonly chunking: ChunkingService,
    private readonly embeddings: PipelineEmbeddingService,
    fetcher: CallbackFetcher = defaultFetcher,
  ) {
    this.semaphore = new AsyncSemaphore(config.unifiedPipelineMaxConcurrency);
    this.fetcher = fetcher;
  }

  async execute(request: PipelineRequest, beforeStart: (() => Promise<boolean>) | undefined = undefined): Promise<PipelineRunResult | undefined> {
    if (!this.config.unifiedPipelineEnabled) return undefined;
    if (request.jobId !== undefined && request.claimToken === undefined) throw new Error("JOB_CLAIM_TOKEN_REQUIRED");
    const release = await this.semaphore.acquire();
    try {
      if (beforeStart !== undefined && !await beforeStart()) return undefined;
      const output = await this.process(request);
      await this.persist(request, output);
      return { result: output.result, resultJson: output.resultJson };
    } finally {
      release();
    }
  }

  createCallbackIntent(job: PipelineJob, result: JsonObject | undefined = undefined): JobDeliveryIntent | undefined {
    if (this.config.callbackUrl === undefined || this.config.callbackSecret === undefined) return undefined;
    return {
      kind: "callback",
      target: this.config.callbackUrl,
      idempotency_key: `job:${job.id ?? ""}:callback:v1`,
      payload: callbackPayload(job, result),
    };
  }

  async deliverCallback(delivery: JobDeliveryIntent): Promise<void> {
    if (this.config.callbackSecret === undefined) throw new Error("callback delivery is not configured");
    const body = jsonString(delivery.payload);
    const signature = createHmac("sha256", this.config.callbackSecret).update(body).digest("hex");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetcher(delivery.target, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Menos-Signature": signature, "Idempotency-Key": delivery.idempotency_key },
        body,
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async updateStage(request: PipelineRequest, stage: PipelineStage, status: PipelineStageStatus, timing: readonly [Date | null | undefined, Date | null | undefined] = [undefined, undefined], errors: readonly [string | null | undefined, string | null | undefined] = [undefined, undefined]): Promise<boolean> {
    if (request.jobId === undefined || this.storage.transition_pipeline_job_stage === undefined) return true;
    const expected: readonly PipelineStageStatus[] = status === "processing" ? ["pending"] : status === "skipped" ? ["pending"] : ["processing"];
    const result = await this.storage.transition_pipeline_job_stage(request.jobId, stage, status, timing, errors, expected, request.claimToken);
    return result !== undefined && result !== null;
  }

  private async skipAfter(request: PipelineRequest, stage: PipelineStage): Promise<void> {
    const index = PIPELINE_STAGES.indexOf(stage);
    for (const skipped of PIPELINE_STAGES.slice(index + 1)) {
      if (!await this.updateStage(request, skipped, "skipped", [undefined, new Date()])) throw new Error("JOB_CLAIM_LOST");
    }
  }

  private instrumentProvider(provider: LlmProvider, request: PipelineRequest, stage: PipelineStage): LlmProvider {
    return {
      model: provider.model,
      generate: async (prompt, options): Promise<string> => {
        const jobId = request.jobId;
        const startedAt = Date.now();
        const labels = { ...(jobId === undefined ? {} : { job_id: jobId }), stage, provider: this.config.unifiedPipelineProvider ?? "configured", model: provider.model };
        emitVaultEvent(this.config.onEvent, { event: "provider.request.started", ...labels });
        try {
          const output = await provider.generate(prompt, options);
          emitVaultEvent(this.config.onEvent, { event: "provider.request.completed", ...labels, duration_ms: Date.now() - startedAt, outcome: "success" });
          return output;
        } catch (error: unknown) {
          emitVaultEvent(this.config.onEvent, { event: "provider.request.failed", ...labels, duration_ms: Date.now() - startedAt, outcome: "failure", error_code: error instanceof PipelineStageError ? error.code : "PROVIDER_REQUEST_FAILED" });
          throw error;
        }
      },
      close: () => provider.close(),
    };
  }

  private async runStage<T>(request: PipelineRequest, stage: PipelineStage, operation: () => Promise<T>): Promise<T> {
    const jobId = request.jobId;
    const startedAt = Date.now();
    emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.started", ...(jobId === undefined ? {} : { job_id: jobId }), stage });
    if (!await this.updateStage(request, stage, "processing", [new Date(), undefined])) throw new Error("JOB_CLAIM_LOST");
    try {
      const result = await operation();
      if (!await this.updateStage(request, stage, "completed", [undefined, new Date()])) throw new Error("JOB_CLAIM_LOST");
      emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.completed", ...(jobId === undefined ? {} : { job_id: jobId }), stage, duration_ms: Date.now() - startedAt });
      return result;
    } catch (error: unknown) {
      const failure = error instanceof PipelineStageError ? error : undefined;
      const errorCode = failure?.code ?? (error instanceof Error && error.message === "JOB_CLAIM_LOST" ? "JOB_CLAIM_LOST" : "PIPELINE_EXCEPTION");
      if (errorCode !== "JOB_CLAIM_LOST") {
        await this.updateStage(request, stage, "failed", [undefined, new Date()], [errorCode, (failure?.message ?? errorMessage(error)).slice(0, 500)]);
        await this.skipAfter(request, stage);
      }
      emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.failed", ...(jobId === undefined ? {} : { job_id: jobId }), stage, duration_ms: Date.now() - startedAt, error_code: errorCode });
      throw error;
    }
  }

  private async process(request: PipelineRequest): Promise<ProcessedPipelineRunResult> {
    const context = await this.runStage(request, "context_fetch", () => this.fetchContext(request.existingTopics));
    const baseProvider = request.jobId === undefined || this.llm.withContext === undefined ? this.llm : this.llm.withContext(`pipeline:${request.jobId}`);
    const provider = this.instrumentProvider(baseProvider, request, "llm_call");
    const parseProvider = this.instrumentProvider(baseProvider, request, "parse");
    const youtube = request.contentType === "youtube";
    const retained = youtube ? analysisSegments(request) : [];
    let parsed: { result: UnifiedResult; aliasMappings: [string, string][] };
    if (youtube && retained.length === 0) {
      // An empty analysis view is an intentional result of filtering. It must
      // never be filled with the original transcript merely to satisfy a
      // model or embedding call.
      await this.updateStage(request, "llm_call", "skipped", [undefined, new Date()]);
      parsed = await this.runStage(request, "parse", async () => ({ result: this.noRetainedContentResult(), aliasMappings: [] }));
    } else if (youtube) {
      const analysis = await this.runStage(request, "llm_call", async () => {
        try {
          return await this.analyzeYouTube(provider, request, context, retained);
        } catch (error: unknown) {
          if (error instanceof PipelineStageError) throw error;
          throw new PipelineStageError("llm_call", "LLM_CALL_ERROR", errorMessage(error).slice(0, 500));
        }
      });
      parsed = await this.runStage(request, "parse", () => this.parseResponse(parseProvider, analysis.response, context.existingTags, { youtube: true, segments: retained, coverage: analysis.coverage }));
    } else {
      const prompt = this.buildPrompt(request, context);
      const response = await this.runStage(request, "llm_call", async () => {
        try {
          return await provider.generate(prompt, { temperature: 0.3, maxTokens: 3000, timeout: 120 });
        } catch (error: unknown) {
          throw new PipelineStageError("llm_call", "LLM_CALL_ERROR", errorMessage(error).slice(0, 500));
        }
      });
      parsed = await this.runStage(request, "parse", () => this.parseResponse(parseProvider, response, context.existingTags));
    }
    const result = parsed.result;
    result.model = provider.model;
    result.processed_at = new Date().toISOString();
    const aliasMappings = [...new Map(parsed.aliasMappings.map((alias) => [`${alias[0]}\u0000${alias[1]}`, alias])).values()]
      .sort(([left], [right]) => left.localeCompare(right));
    return { result, resultJson: this.resultJson(result), aliasMappings };
  }

  private noRetainedContentResult(): UnifiedResult {
    const structured: CanonicalSummary = {
      version: 1,
      overview: "No retained transcript content was available for analysis.",
      key_points: ["No retained content was available."],
    };
    return {
      tags: [],
      new_tags: [],
      tier: "C",
      tier_explanation: ["No retained transcript content was available for evaluation."],
      quality_score: 1,
      score_explanation: ["No retained transcript content was available for evaluation."],
      summary: legacySummaryFromCanonical(structured),
      structured_summary: structured,
      outline: { version: 1, sections: [] },
      summary_coverage: {
        status: "full",
        source_variant: "analysis",
        generation_method: "no_retained_content",
        source_segment_count: 0,
        source_range_count: 0,
        analyzed_segment_count: 0,
        analyzed_range_count: 0,
        analyzed_chunk_count: 0,
      },
      topics: [],
      pre_detected_validations: [],
      additional_entities: [],
    };
  }

  private analysisBudget(): number {
    return this.config.unifiedPipelineInputBudget ?? DEFAULT_ANALYSIS_INPUT_BUDGET_TOKENS;
  }

  private detectedEntities(request: PipelineRequest): string {
    return asciiJson(JSON.stringify((request.preDetected ?? []).map((entity) => ({
      entity_id: entity.id === undefined ? `entity:${entity.normalized_name}` : `entity:${entity.id}`,
      type: entity.entity_type,
      name: entity.name,
    })), undefined, 2));
  }

  private youtubeReplacements(request: PipelineRequest, context: PromptContext, source: string, index: string): Record<string, string> {
    return {
      title: request.title,
      existing_tags: context.existingTags.length === 0 ? "None yet" : context.existingTags.slice(0, 50).join(", "),
      pre_detected_entities_json: this.detectedEntities(request),
      existing_topics: context.promptTopics.length === 0 ? "None yet" : context.promptTopics.slice(0, 20).join(", "),
      tag_cooccurrence: this.formatCooccurrence(context.tagCooccurrence),
      tier_distribution: this.formatDistribution(context.tierDistribution),
      known_aliases: Object.keys(context.knownAliases).length === 0 ? "None yet" : Object.entries(context.knownAliases).map(([variant, canonical]) => `${variant} -> ${canonical}`).join(", "),
      max_new_tags: String(this.config.unifiedPipelineMaxNewTags),
      content_text: source,
      source_index: index,
    };
  }

  private replaceYouTubePrompt(template: string, replacements: Record<string, string>): string {
    return template.replace(/\{([a-z_]+)\}/g, (match, key: string) => replacements[key] ?? match);
  }

  private formatAnalysisSegments(segments: readonly AnalysisSourceSegment[]): string {
    return segments.map((segment) => {
      const timing = segment.start_seconds === undefined || segment.duration_seconds === undefined
        ? "timing unavailable"
        : `start=${segment.start_seconds}s duration=${segment.duration_seconds}s`;
      return `[${segment.source_segment_id}; ${timing}]\n${segment.text}`;
    }).join("\n\n");
  }

  private async analyzeYouTube(provider: LlmProvider, request: PipelineRequest, context: PromptContext, segments: AnalysisSourceSegment[]): Promise<{ response: string; coverage: YouTubeAnalysisContext }> {
    const sourceIndexText = sourceIndex(segments);
    const sourceRange = sourceRangeCount(segments);
    const singleReplacements = this.youtubeReplacements(request, context, "", sourceIndexText);
    const singleOverhead = estimateAnalysisTokens(this.replaceYouTubePrompt(YOUTUBE_SINGLE_PROMPT_TEMPLATE, singleReplacements));
    const plan = planAnalysisChunks(segments, {
      budgetTokens: this.analysisBudget(),
      outputReservationTokens: DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS,
      promptOverheadTokens: singleOverhead,
    });
    const coverage: YouTubeAnalysisContext = {
      segments,
      sourceIndex: sourceIndexText,
      sourceRangeCount: sourceRange,
      sourceChunkCount: plan.chunks.length,
      generationMethod: plan.chunks.length === 1 ? "single_call" : "map_reduce",
    };
    if (plan.chunks.length === 1) {
      const prompt = this.replaceYouTubePrompt(YOUTUBE_SINGLE_PROMPT_TEMPLATE, this.youtubeReplacements(request, context, plan.chunks[0]?.text ?? "", sourceIndexText));
      return { response: await provider.generate(prompt, { temperature: 0.3, maxTokens: DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS, timeout: 120 }), coverage };
    }

    const notes: ParsedAnalysisNote[] = [];
    for (const chunk of plan.chunks) {
      const chunkIndex = sourceIndex(chunk.segments);
      const prompt = this.replaceYouTubePrompt(YOUTUBE_MAP_PROMPT, { content_text: this.formatAnalysisSegments(chunk.segments), source_index: chunkIndex });
      const response = await provider.generate(prompt, { temperature: 0.2, maxTokens: INTERMEDIATE_ANALYSIS_OUTPUT_TOKENS, timeout: 120 });
      const note = parseAnalysisNote(extractJson(response), chunk.segments.map((segment) => segment.source_segment_id));
      if (note === undefined) throw new PipelineStageError("llm_call", "ANALYSIS_MAP_FAILED", `Analysis unit ${chunk.index + 1} returned an invalid note`);
      notes.push(note);
    }

    let current: ParsedAnalysisNote[] = notes;
    const synthesisOverhead = this.replaceYouTubePrompt(YOUTUBE_SYNTHESIS_PROMPT, {
      title: request.title,
      existing_tags: context.existingTags.length === 0 ? "None yet" : context.existingTags.slice(0, 50).join(", "),
      existing_topics: context.promptTopics.length === 0 ? "None yet" : context.promptTopics.slice(0, 20).join(", "),
      pre_detected_entities_json: this.detectedEntities(request),
      tag_cooccurrence: this.formatCooccurrence(context.tagCooccurrence),
      tier_distribution: this.formatDistribution(context.tierDistribution),
      known_aliases: Object.keys(context.knownAliases).length === 0 ? "None yet" : Object.entries(context.knownAliases).map(([variant, canonical]) => `${variant} -> ${canonical}`).join(", "),
      source_index: sourceIndexText,
      notes: "",
    });
    const reductionPlan = planAdjacentReduction(current, {
      budgetTokens: this.analysisBudget(),
      outputReservationTokens: DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS,
      promptOverheadTokens: estimateAnalysisTokens(synthesisOverhead),
      intermediateOutputReservationTokens: INTERMEDIATE_ANALYSIS_OUTPUT_TOKENS,
    });
    for (const level of reductionPlan.levels) {
      const next: ParsedAnalysisNote[] = [];
      for (const batch of level.batches) {
        const batchNotes = batch.note_indexes.map((index) => current[index]).filter((note): note is ParsedAnalysisNote => note !== undefined);
        const notesText = batchNotes.map((note, index) => `NOTE ${index + 1} [${note.source_segment_ids.join(", ")}]:\n${note.text}`).join("\n\n");
        const prompt = YOUTUBE_REDUCTION_PROMPT.replace("{notes}", notesText);
        const response = await provider.generate(prompt, { temperature: 0.2, maxTokens: INTERMEDIATE_ANALYSIS_OUTPUT_TOKENS, timeout: 120 });
        const note = parseAnalysisNote(extractJson(response), batch.source_segment_ids);
        if (note === undefined) throw new PipelineStageError("llm_call", "ANALYSIS_REDUCTION_FAILED", `Analysis reduction ${batch.index + 1} returned an invalid note`);
        next.push(note);
      }
      current = next;
    }
    const notesText = current.map((note, index) => `NOTE ${index + 1} [${note.source_segment_ids.join(", ")}]:\n${note.text}`).join("\n\n");
    const synthesis = this.replaceYouTubePrompt(YOUTUBE_SYNTHESIS_PROMPT, {
      title: request.title,
      existing_tags: context.existingTags.length === 0 ? "None yet" : context.existingTags.slice(0, 50).join(", "),
      existing_topics: context.promptTopics.length === 0 ? "None yet" : context.promptTopics.slice(0, 20).join(", "),
      pre_detected_entities_json: this.detectedEntities(request),
      tag_cooccurrence: this.formatCooccurrence(context.tagCooccurrence),
      tier_distribution: this.formatDistribution(context.tierDistribution),
      known_aliases: Object.keys(context.knownAliases).length === 0 ? "None yet" : Object.entries(context.knownAliases).map(([variant, canonical]) => `${variant} -> ${canonical}`).join(", "),
      source_index: sourceIndexText,
      notes: notesText,
    });
    return { response: await provider.generate(synthesis, { temperature: 0.3, maxTokens: DEFAULT_ANALYSIS_OUTPUT_RESERVATION_TOKENS, timeout: 120 }), coverage };
  }

  private async fetchContext(existingTopics: readonly string[] | undefined): Promise<PromptContext> {
    try {
      const [tags, topics, tagCooccurrence, tierDistribution, knownAliases] = await Promise.all([
        this.storage.list_tags_with_counts(),
        existingTopics === undefined || existingTopics.length === 0 ? this.storage.get_topic_hierarchy().then((entities) => entities.flatMap((entity) => entity.hierarchy === undefined || entity.hierarchy === null ? [entity.name] : [entity.hierarchy.join(" > ")])) : Promise.resolve([...existingTopics]),
        this.storage.get_tag_cooccurrence(),
        this.storage.get_tier_distribution(),
        this.storage.get_tag_aliases(),
      ]);
      return {
        existingTags: tags.flatMap((tag) => typeof tag.name === "string" ? [tag.name] : []),
        promptTopics: topics,
        tagCooccurrence,
        tierDistribution,
        knownAliases,
      };
    } catch (error: unknown) {
      throw new PipelineStageError("context_fetch", "CONTEXT_FETCH_ERROR", errorMessage(error).slice(0, 500));
    }
  }

  private buildPrompt(request: PipelineRequest, context: PromptContext): string {
    const content = request.contentText.length > 10_000 ? `${request.contentText.slice(0, 10_000)}\n\n[Content truncated...]` : request.contentText;
    const detected = (request.preDetected ?? []).map((entity) => ({
      entity_id: entity.id === undefined ? `entity:${entity.normalized_name}` : `entity:${entity.id}`,
      type: entity.entity_type,
      name: entity.name,
    }));
    const replacements: Record<string, string> = {
      content_type: request.contentType,
      title: request.title,
      existing_tags: context.existingTags.length === 0 ? "None yet" : context.existingTags.slice(0, 50).join(", "),
      pre_detected_entities_json: asciiJson(JSON.stringify(detected, undefined, 2)),
      existing_topics: context.promptTopics.length === 0 ? "None yet" : context.promptTopics.slice(0, 20).join(", "),
      tag_cooccurrence: this.formatCooccurrence(context.tagCooccurrence),
      tier_distribution: this.formatDistribution(context.tierDistribution),
      known_aliases: Object.keys(context.knownAliases).length === 0 ? "None yet" : Object.entries(context.knownAliases).map(([variant, canonical]) => `${variant} -> ${canonical}`).join(", "),
      max_new_tags: String(this.config.unifiedPipelineMaxNewTags),
      content_text: content,
    };
    return UNIFIED_PROMPT_TEMPLATE.replace(/\{([a-z_]+)\}/g, (match, key: string) => replacements[key] ?? match);
  }

  private formatCooccurrence(value: Record<string, string[]>): string {
    const entries = Object.entries(value).filter(([, related]) => related.length > 0).sort(([left], [right]) => left.localeCompare(right));
    return entries.length === 0 ? "None yet" : entries.map(([tag, related]) => `- ${tag} often appears with: ${related.join(", ")}`).join("\n");
  }

  private formatDistribution(value: Record<string, number>): string {
    const total = Object.values(value).reduce((sum, count) => sum + Math.max(count, 0), 0);
    return total <= 0 ? "No data" : ["S", "A", "B", "C", "D"].map((tier) => `${tier}=${Math.round((Math.max(value[tier] ?? 0, 0) / total) * 100)}%`).join(", ");
  }

  private async parseResponse(
    provider: LlmProvider,
    response: string,
    existingTags: string[],
    options: { youtube?: boolean; segments?: readonly AnalysisSourceSegment[]; coverage?: YouTubeAnalysisContext } = {},
  ): Promise<{ result: UnifiedResult; aliasMappings: [string, string][] }> {
    const initial = this.parseUnifiedResponse(extractJson(response), existingTags, options);
    if (initial !== undefined && (initial.result.topics?.length ?? 0) > 0 && (!options.youtube || initial.result.structured_summary !== undefined)) return initial;

    let corrected: { result: UnifiedResult; aliasMappings: [string, string][] } | undefined;
    try {
      const correctionSourceIndex = options.segments === undefined ? "None" : sourceIndex(options.segments);
      const correction = options.youtube
        ? `Repair the previous response into the complete canonical JSON schema below. Preserve correct classification and entity fields. The structured_summary is required, and the outline must be version 1. Use only source IDs from this source index. Do not add transcript text. Respond ONLY with valid JSON, no markdown or explanation.\nSOURCE INDEX:\n${correctionSourceIndex}\n{"tags":[],"new_tags":[],"tier":"B","tier_explanation":[],"quality_score":50,"score_explanation":[],"structured_summary":{"version":1,"overview":"overview","key_points":["point 1"]},"outline":{"version":1,"sections":[]},"topics":[{"name":"Parent > Child","confidence":"high","edge_type":"discusses"}],"pre_detected_validations":[],"additional_entities":[]}\n\nPrevious response:\n${response.slice(0, 3000)}`
        : `Repair the previous response into the complete canonical JSON schema below. Preserve all correct fields from the previous response. Respond ONLY with valid JSON, no markdown or explanation.\n{"tags":["tag"],"new_tags":["tag"],"tier":"B","tier_explanation":["reason"],"quality_score":50,"score_explanation":["reason"],"summary":"summary","structured_summary":{"version":1,"overview":"overview","key_points":["point 1","point 2","point 3"]},"topics":[{"name":"Parent > Child","confidence":"high","edge_type":"discusses"}],"pre_detected_validations":[{"entity_id":"entity:id","edge_type":"mentions","confirmed":true}],"additional_entities":[{"type":"tool","name":"name","confidence":"medium","edge_type":"mentions"}]}\n"structured_summary" is optional for legacy compatibility. When present, it must have version 1, an overview, and a key_points array. "topics" must contain 3-7 objects with name, confidence, and edge_type. "additional_entities" must be an array but may be empty.\n\nPrevious response:\n${response.slice(0, 3000)}`;
      corrected = this.parseUnifiedResponse(extractJson(await provider.generate(correction, { temperature: 0.1, maxTokens: 3000, timeout: 60 })), existingTags, options);
    } catch {
      corrected = undefined;
    }
    if (corrected === undefined || (corrected.result.topics?.length ?? 0) === 0 || (options.youtube && corrected.result.structured_summary === undefined)) {
      throw new PipelineStageError("parse", "PARSE_FAILED", "Unified pipeline response was invalid or missing topics");
    }
    return corrected;
  }

  private parseUnifiedResponse(
    data: JsonObject | undefined,
    existingTags: string[],
    options: { youtube?: boolean; segments?: readonly AnalysisSourceSegment[]; coverage?: YouTubeAnalysisContext } = {},
  ): { result: UnifiedResult; aliasMappings: [string, string][] } | undefined {
    if (data === undefined) return undefined;
    const recognized = ["tags", "new_tags", "tier", "quality_score", "topics", "pre_detected_validations", "additional_entities", "summary", "structured_summary", "outline"];
    if (!recognized.some((field) => field in data)) return undefined;
    const aliases: [string, string][] = [];
    const tags = validLabels(data.tags);
    const newTags: string[] = [];
    for (const tag of validLabels(data.new_tags)) {
      if (newTags.length >= this.config.unifiedPipelineMaxNewTags) break;
      const match = dedupLabel(tag, [...existingTags, ...tags]);
      if (match !== undefined) {
        if (normalizedName(tag) !== normalizedName(match)) aliases.push([tag, match]);
        if (!tags.includes(match)) tags.push(match);
      } else if (!tags.includes(tag)) {
        tags.push(tag);
        newTags.push(tag);
      }
    }
    const tier = typeof data.tier === "string" && VALID_TIERS.has(data.tier.toUpperCase()) ? data.tier.toUpperCase() : "C";
    const rawScore = typeof data.quality_score === "number" || typeof data.quality_score === "string" ? Number.parseInt(String(data.quality_score), 10) : 50;
    const score = Number.isNaN(rawScore) ? 50 : Math.min(100, Math.max(1, rawScore));
    const parsedStructured = structuredSummary(data.structured_summary);
    const canonicalYouTube = options.youtube && parsedStructured !== undefined;
    const result: UnifiedResult = {
      tags,
      new_tags: newTags,
      tier,
      tier_explanation: explanations(data.tier_explanation),
      quality_score: score,
      score_explanation: explanations(data.score_explanation),
      summary: canonicalYouTube ? legacySummaryFromCanonical(parsedStructured) : typeof data.summary === "string" ? data.summary : "",
      ...(parsedStructured === undefined ? {} : { structured_summary: parsedStructured }),
      ...(canonicalYouTube ? { outline: parseGroundedOutline(data.outline, options.segments ?? []) ?? { version: 1, sections: [] } } : {}),
      ...(canonicalYouTube && options.coverage !== undefined ? { summary_coverage: {
        status: "full",
        source_variant: "analysis",
        generation_method: options.coverage.generationMethod,
        source_segment_count: options.coverage.segments.length,
        source_range_count: options.coverage.sourceRangeCount,
        analyzed_segment_count: options.coverage.segments.length,
        analyzed_range_count: options.coverage.sourceRangeCount,
        analyzed_chunk_count: options.coverage.sourceChunkCount,
      } as const } : {}),
      topics: this.parseTopics(data.topics),
      pre_detected_validations: this.parseValidations(data.pre_detected_validations),
      additional_entities: this.parseAdditionalEntities(data.additional_entities),
    };
    return { result, aliasMappings: aliases };
  }

  private parseTopics(value: unknown): ExtractedEntity[] {
    if (!Array.isArray(value)) return [];
    const topics: ExtractedEntity[] = [];
    for (const item of value) {
      const topic = record(item);
      if (topic === undefined || typeof topic.name !== "string" || topic.name === "") continue;
      if (topics.length >= this.config.entityMaxTopicsPerContent) continue;
      const confidence = typeof topic.confidence === "string" ? topic.confidence : "medium";
      if (confidenceValue(confidence) < this.config.entityMinConfidence) continue;
      const hierarchy = topic.name.split(">").map((part) => part.trim()).filter(Boolean);
      if (hierarchy.length === 0) continue;
      topics.push({ entity_type: EntityTypes.TOPIC, name: hierarchy.at(-1) ?? topic.name, confidence, edge_type: edgeType(topic.edge_type ?? "discusses"), hierarchy });
    }
    return topics;
  }

  private parseValidations(value: unknown): PreDetectedValidation[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const validation = record(item);
      return validation === undefined || typeof validation.entity_id !== "string" || validation.entity_id === "" ? [] : [{ entity_id: validation.entity_id, edge_type: edgeType(validation.edge_type), confirmed: validation.confirmed === undefined ? true : Boolean(validation.confirmed) }];
    });
  }

  private parseAdditionalEntities(value: unknown): ExtractedEntity[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      const entity = record(item);
      if (entity === undefined || typeof entity.name !== "string" || entity.name === "") return [];
      const confidence = typeof entity.confidence === "string" ? entity.confidence : "medium";
      if (confidenceValue(confidence) < this.config.entityMinConfidence) return [];
      return [{ entity_type: entityType(entity.type ?? "tool"), name: entity.name, confidence, edge_type: edgeType(entity.edge_type), hierarchy: null }];
    });
  }

  private async persist(request: PipelineRequest, output: ProcessedPipelineRunResult): Promise<void> {
    const embeddingSource = request.contentType === "youtube" ? sourceText(analysisSegments(request)) : request.contentText;
    const chunkTexts = await this.runStage(request, "chunking", async () => this.chunking.chunkText(embeddingSource));
    const embeddings = await this.runStage(request, "embedding", async () => {
      // An entirely filtered transcript is a valid empty source. Do not turn it
      // into a placeholder chunk, and do not ask the embedding provider to
      // embed the unfiltered original as a fallback.
      if (chunkTexts.length === 0) return [];
      let result: number[][];
      try {
        result = await this.embeddings.embedBatch(chunkTexts);
      } catch (error: unknown) {
        throw new PipelineStageError("embedding", "EMBEDDING_ERROR", errorMessage(error));
      }
      if (result.length !== chunkTexts.length || result.some((embedding) => embedding.length !== 1024)) {
        throw new PipelineStageError("embedding", "EMBEDDING_DIMENSION_ERROR", "Embedding output did not match the chunk count and required dimension");
      }
      return result;
    });
    const chunks = chunkTexts.map((text, chunkIndex) => ({ content_id: request.contentId, text, chunk_index: chunkIndex, embedding: embeddings[chunkIndex] }));
    if (request.jobId === undefined) {
      await this.runStage(request, "persist", async () => {
        await Promise.all(output.aliasMappings.map(([variant, canonical]) => this.storage.record_tag_alias(variant, canonical)));
        const relationships = await this.resolveRelationships(request.contentId, output.result);
        await this.storage.complete_content_processing(request.contentId, output.resultJson, request.pipelineVersion, chunks, relationships);
      });
      return;
    }
    await this.persistClaimed(request, output, chunks);
  }

  private async persistClaimed(request: PipelineRequest, output: ProcessedPipelineRunResult, chunks: ChunkModel[]): Promise<void> {
    const jobId = request.jobId;
    const claimToken = request.claimToken;
    if (jobId === undefined || claimToken === undefined) throw new Error("JOB_CLAIM_TOKEN_REQUIRED");
    const startedAt = Date.now();
    emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.started", job_id: jobId, stage: "persist" });
    if (!await this.updateStage(request, "persist", "processing", [new Date(), undefined])) throw new Error("JOB_CLAIM_LOST");
    try {
      const prepared = this.prepareClaimedRelationships(request.contentId, output.result);
      const completedAt = new Date();
      const committed = await this.storage.complete_content_processing(
        request.contentId,
        output.resultJson,
        request.pipelineVersion,
        chunks,
        prepared.relationships,
        { aliases: output.aliasMappings, entities: prepared.entities, jobId, claimToken, persistStageCompletedAt: completedAt },
      );
      if (committed === false) throw new Error("JOB_CLAIM_LOST");
      // Void is retained only for pre-fencing test/direct storage implementations.
      // The production repository returns a boolean and commits this transition
      // in the content transaction.
      if (committed === undefined && !await this.updateStage(request, "persist", "completed", [undefined, completedAt])) throw new Error("JOB_CLAIM_LOST");
      emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.completed", job_id: jobId, stage: "persist", duration_ms: Date.now() - startedAt });
    } catch (error: unknown) {
      const claimLost = error instanceof Error && error.message === "JOB_CLAIM_LOST";
      if (!claimLost) await this.updateStage(request, "persist", "failed", [undefined, new Date()], ["PIPELINE_EXCEPTION", errorMessage(error).slice(0, 500)]);
      emitVaultEvent(this.config.onEvent, { event: "pipeline.stage.failed", job_id: jobId, stage: "persist", duration_ms: Date.now() - startedAt, error_code: claimLost ? "JOB_CLAIM_LOST" : "PIPELINE_EXCEPTION" });
      throw error;
    }
  }

  private prepareClaimedRelationships(contentId: string, result: UnifiedResult): { entities: PipelineEntityCandidate[]; relationships: ContentEntityEdge[] } {
    const entities: PipelineEntityCandidate[] = [];
    const references = new Map<string, string>();
    const edges = new Map<string, ContentEntityEdge>();
    for (const extracted of [...(result.topics ?? []), ...(result.additional_entities ?? [])]) {
      const key = `${extracted.entity_type}\u0000${normalizedName(extracted.name)}`;
      let referenceId = references.get(key);
      if (referenceId === undefined) {
        referenceId = `__pipeline_entity_${entities.length}`;
        references.set(key, referenceId);
        entities.push({ referenceId, name: extracted.name, entityType: extracted.entity_type, hierarchy: extracted.hierarchy ?? null });
      }
      const edge: ContentEntityEdge = { content_id: contentId, entity_id: referenceId, edge_type: extracted.edge_type, confidence: confidenceValue(extracted.confidence) };
      edges.set(`${edge.entity_id}\u0000${edge.edge_type}`, edge);
    }
    for (const validation of result.pre_detected_validations ?? []) {
      if (!validation.confirmed) continue;
      const edge: ContentEntityEdge = { content_id: contentId, entity_id: validation.entity_id.replace(/^entity:/, ""), edge_type: validation.edge_type };
      edges.set(`${edge.entity_id}\u0000${edge.edge_type}`, edge);
    }
    return { entities, relationships: [...edges.values()] };
  }

  private async resolveRelationships(contentId: string, result: UnifiedResult): Promise<ContentEntityEdge[]> {
    const edges = new Map<string, ContentEntityEdge>();
    for (const extracted of [...(result.topics ?? []), ...(result.additional_entities ?? [])]) {
      const [entity] = await this.storage.find_or_create_entity(extracted.name, extracted.entity_type, { hierarchy: extracted.hierarchy ?? null });
      if (entity.id === undefined || entity.id === "") throw new Error(`resolved entity has no ID: ${extracted.name}`);
      const edge: ContentEntityEdge = { content_id: contentId, entity_id: entity.id, edge_type: extracted.edge_type, confidence: confidenceValue(extracted.confidence) };
      edges.set(`${edge.entity_id}\u0000${edge.edge_type}`, edge);
    }
    for (const validation of result.pre_detected_validations ?? []) {
      if (!validation.confirmed) continue;
      const edge: ContentEntityEdge = { content_id: contentId, entity_id: validation.entity_id.replace(/^entity:/, ""), edge_type: validation.edge_type };
      edges.set(`${edge.entity_id}\u0000${edge.edge_type}`, edge);
    }
    return [...edges.values()];
  }

  private resultJson(result: UnifiedResult): JsonObject {
    return {
      tags: result.tags ?? [],
      new_tags: result.new_tags ?? [],
      tier: result.tier ?? "",
      tier_explanation: result.tier_explanation ?? [],
      quality_score: result.quality_score ?? 0,
      score_explanation: result.score_explanation ?? [],
      summary: result.summary ?? "",
      ...(result.structured_summary === undefined ? {} : {
        structured_summary: {
          version: 1,
          overview: result.structured_summary.overview,
          key_points: [...result.structured_summary.key_points],
        },
      }),
      ...(result.outline === undefined ? {} : {
        outline: {
          version: 1,
          sections: result.outline.sections.map((section) => ({
            heading: section.heading,
            description: section.description,
            ...(section.source === undefined ? {} : {
              source: {
                ...(section.source.segment_ids === undefined ? {} : { segment_ids: [...section.source.segment_ids] }),
                ...(section.source.start_seconds === undefined || section.source.end_seconds === undefined ? {} : { start_seconds: section.source.start_seconds, end_seconds: section.source.end_seconds }),
              },
            }),
          })),
        },
      }),
      ...(result.summary_coverage === undefined ? {} : {
        summary_coverage: { ...result.summary_coverage },
      }),
      topics: (result.topics ?? []).map((topic) => ({ entity_type: topic.entity_type, name: topic.name, confidence: topic.confidence, edge_type: topic.edge_type, hierarchy: topic.hierarchy ?? null })),
      pre_detected_validations: (result.pre_detected_validations ?? []).map((validation) => ({ entity_id: validation.entity_id, edge_type: validation.edge_type, confirmed: validation.confirmed })),
      additional_entities: (result.additional_entities ?? []).map((entity) => ({ entity_type: entity.entity_type, name: entity.name, confidence: entity.confidence, edge_type: entity.edge_type, hierarchy: entity.hierarchy ?? null })),
      model: result.model ?? "",
      processed_at: result.processed_at ?? "",
    };
  }
}
