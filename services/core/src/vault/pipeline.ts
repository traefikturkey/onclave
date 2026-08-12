import { createHash, createHmac } from "node:crypto";
import type { VaultConfig } from "./config";
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
  UnifiedResult,
} from "./models";
import { EdgeType, EntityType as EntityTypes } from "./models";
import type { LlmProvider } from "./llm-providers";

const VALID_TIERS = new Set(["S", "A", "B", "C", "D"]);
const LABEL_PATTERN = /^[a-z][a-z0-9-]*$/;
const CALLBACK_NAMESPACE = "a1b2c3d4e5f67890abcdef1234567890";

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
- Generate a summary: a 2-3 sentence overview followed by 3-5 bullet points of main topics

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
>;

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
  preDetected?: readonly PreDetectedEntity[];
  existingTopics?: readonly string[];
  pipelineVersion: string;
};

export type PipelineStorage = {
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
  ): Promise<void>;
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

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const release = await this.semaphore.acquire();
    try {
      if (beforeStart !== undefined && !await beforeStart()) return undefined;
      const output = await this.process(request);
      await this.persist(request, output);
      return output;
    } finally {
      release();
    }
  }

  async deliverCallback(job: PipelineJob, result: JsonObject | undefined = undefined): Promise<void> {
    if (this.config.callbackUrl === undefined || this.config.callbackSecret === undefined) return;
    const body = jsonString(callbackPayload(job, result));
    const signature = createHmac("sha256", this.config.callbackSecret).update(body).digest("hex");
    const headers = { "Content-Type": "application/json", "X-Menos-Signature": signature };
    for (const [index, delay] of [1_000, 4_000, 16_000].entries()) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await this.fetcher(this.config.callbackUrl, { method: "POST", headers, body, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return;
      } catch {
        clearTimeout(timeout);
        if (index < 2) await wait(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  private async process(request: PipelineRequest): Promise<PipelineRunResult> {
    const context = await this.fetchContext(request.existingTopics);
    const provider = request.jobId === undefined || this.llm.withContext === undefined ? this.llm : this.llm.withContext(`pipeline:${request.jobId}`);
    const prompt = this.buildPrompt(request, context);
    let response: string;
    try {
      response = await provider.generate(prompt, { temperature: 0.3, maxTokens: 3000, timeout: 120 });
    } catch (error: unknown) {
      throw new PipelineStageError("llm_call", "LLM_CALL_ERROR", errorMessage(error).slice(0, 500));
    }
    const parsed = await this.parseResponse(provider, response, context.existingTags, request.contentId);
    const result = parsed.result;
    result.model = provider.model;
    result.processed_at = new Date().toISOString();
    if (parsed.aliasMappings.length > 0) {
      const aliases = [...new Map(parsed.aliasMappings.map((alias) => [`${alias[0]}\u0000${alias[1]}`, alias])).values()]
        .sort(([left], [right]) => left.localeCompare(right));
      await Promise.all(aliases.map(([variant, canonical]) => this.storage.record_tag_alias(variant, canonical)));
    }
    return { result, resultJson: this.resultJson(result) };
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

  private async parseResponse(provider: LlmProvider, response: string, existingTags: string[], contentId: string): Promise<{ result: UnifiedResult; aliasMappings: [string, string][] }> {
    let data = extractJson(response);
    if (data === undefined) {
      const correction = `Your previous response was not valid JSON. Convert the following content into the exact JSON format requested. Respond ONLY with valid JSON, no markdown, no explanation.\n\n${response.slice(0, 3000)}`;
      try {
        data = extractJson(await provider.generate(correction, { temperature: 0.1, maxTokens: 3000, timeout: 60 }));
      } catch {
        data = undefined;
      }
    }
    if (data === undefined) throw new PipelineStageError("parse", "EMPTY_RESPONSE", `Empty unified pipeline response for ${contentId}`);
    const result = this.parseUnifiedResponse(data, existingTags);
    if (result === undefined) throw new PipelineStageError("parse", "PARSE_FAILED", `Failed to parse unified response for ${contentId}`);
    return result;
  }

  private parseUnifiedResponse(data: JsonObject, existingTags: string[]): { result: UnifiedResult; aliasMappings: [string, string][] } | undefined {
    const recognized = ["tags", "new_tags", "tier", "quality_score", "topics", "pre_detected_validations", "additional_entities", "summary"];
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
    const result: UnifiedResult = {
      tags,
      new_tags: newTags,
      tier,
      tier_explanation: explanations(data.tier_explanation),
      quality_score: score,
      score_explanation: explanations(data.score_explanation),
      summary: typeof data.summary === "string" ? data.summary : "",
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

  private async persist(request: PipelineRequest, output: PipelineRunResult): Promise<void> {
    const chunkTexts = this.chunking.chunkText(request.contentText);
    if (chunkTexts.length === 0) throw new PipelineStageError("chunking", "CHUNKING_EMPTY", "Content produced no chunks");
    let embeddings: number[][];
    try {
      embeddings = await this.embeddings.embedBatch(chunkTexts);
    } catch (error: unknown) {
      throw new PipelineStageError("embedding", "EMBEDDING_ERROR", errorMessage(error));
    }
    if (embeddings.length !== chunkTexts.length || embeddings.some((embedding) => embedding.length !== 1024)) {
      throw new PipelineStageError("embedding", "EMBEDDING_DIMENSION_ERROR", "Embedding output did not match the chunk count and required dimension");
    }
    const chunks = chunkTexts.map((text, chunkIndex) => ({ content_id: request.contentId, text, chunk_index: chunkIndex, embedding: embeddings[chunkIndex] }));
    const relationships = await this.resolveRelationships(request.contentId, output.result);
    await this.storage.complete_content_processing(request.contentId, output.resultJson, request.pipelineVersion, chunks, relationships);
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
      topics: (result.topics ?? []).map((topic) => ({ entity_type: topic.entity_type, name: topic.name, confidence: topic.confidence, edge_type: topic.edge_type, hierarchy: topic.hierarchy ?? null })),
      pre_detected_validations: (result.pre_detected_validations ?? []).map((validation) => ({ entity_id: validation.entity_id, edge_type: validation.edge_type, confirmed: validation.confirmed })),
      additional_entities: (result.additional_entities ?? []).map((entity) => ({ entity_type: entity.entity_type, name: entity.name, confidence: entity.confidence, edge_type: entity.edge_type, hierarchy: entity.hierarchy ?? null })),
      model: result.model ?? "",
      processed_at: result.processed_at ?? "",
    };
  }
}
