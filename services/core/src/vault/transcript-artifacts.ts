import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type {
  AnalysisTranscript,
  CurrentTranscriptProvenance,
  OriginalTranscript,
  SponsorBlockLookupProvenance,
  TranscriptAnalysisMetadata,
  TranscriptArtifactMetadata,
  TranscriptArtifactSet,
  TranscriptDownloadVariant,
  TranscriptFilteringProvenance,
  TimedTranscript,
  WholeTranscriptAccess,
  WholeTranscriptResolution,
  WholeTranscriptResolver,
} from "./transcript-analysis";
import {
  createAnalysisTranscript,
  normalizeOriginalTranscript,
  normalizeTranscriptAnalysisMetadata,
  serializeTranscript,
  toTimedTranscript,
  TRANSCRIPT_ANALYSIS_CONTRACT_VERSION,
} from "./transcript-analysis";
import type { ContentMetadata, JsonObject, JsonValue } from "./models";
import {
  filterTranscriptForAnalysis,
  isSponsorBlockLookupReusable,
  SponsorBlockService,
} from "./sponsorblock";

export type TranscriptSponsorBlock = {
  lookup(videoId: string, options?: {
    existing?: SponsorBlockLookupProvenance;
    publicationDate?: string | null;
    videoDurationSeconds?: number | null;
  }): Promise<SponsorBlockLookupProvenance>;
};

export type TranscriptArtifactStorage = {
  upload(filePath: string, data: Readable, contentType: string): Promise<number>;
  download(filePath: string): Promise<Buffer>;
};

export type TranscriptArtifactRepository = {
  get_content(contentId: string): Promise<ContentMetadata | undefined>;
  update_content(contentId: string, metadata: ContentMetadata): Promise<ContentMetadata>;
};

export type TranscriptArtifactResolverOptions = {
  storage: TranscriptArtifactStorage;
  repository: TranscriptArtifactRepository;
  sponsorblock?: TranscriptSponsorBlock;
  now?: () => Date;
};

const TRANSCRIPT_ARTIFACT_CONTENT_TYPE = "application/json";
const TRANSCRIPT_TEXT_CONTENT_TYPE = "text/plain";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function metadataValue(content: ContentMetadata): Record<string, unknown> {
  return record(content.metadata) ?? {};
}

function jsonValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function isoDate(value: Date | null | undefined, fallback: Date): string {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : fallback.toISOString();
}

function validNow(now: (() => Date) | undefined): Date {
  const value = now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("transcript resolver clock returned an invalid date");
  return new Date(value.getTime());
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactSource(variant: TranscriptArtifactMetadata["variant"]): TranscriptArtifactMetadata["source"] {
  return variant === "original" ? "original_transcript" : variant === "timed" ? "timed_transcript" : "analysis_transcript";
}

function artifactWithDigest(
  variant: TranscriptArtifactMetadata["variant"],
  objectKey: string,
  bytes: Buffer,
  createdAt: string,
  mimeType = TRANSCRIPT_ARTIFACT_CONTENT_TYPE,
): TranscriptArtifactMetadata {
  return {
    variant,
    object_key: objectKey,
    mime_type: mimeType,
    byte_length: bytes.length,
    sha256: sha256(bytes),
    created_at: createdAt,
    source: artifactSource(variant),
  };
}

function siblingObjectKey(originalKey: string, suffix: string): string {
  const slash = originalKey.lastIndexOf("/");
  const directory = slash < 0 ? "" : originalKey.slice(0, slash + 1);
  const filename = slash < 0 ? originalKey : originalKey.slice(slash + 1);
  const extension = filename.lastIndexOf(".");
  const stem = extension <= 0 ? filename : filename.slice(0, extension);
  return `${directory}${stem}.${suffix}.json`;
}

function analysisObjectKey(originalKey: string): string {
  return siblingObjectKey(originalKey, "analysis");
}

function serializeRepresentation(value: OriginalTranscript | TimedTranscript | AnalysisTranscript): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function parseOriginal(bytes: Buffer): OriginalTranscript | undefined {
  const text = bytes.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    const normalized = normalizeOriginalTranscript(parsed);
    if (normalized !== undefined) return normalized;
  } catch {
    // Older content is a plain text object. It is intentionally treated as untimed.
  }
  return normalizeOriginalTranscript({ text });
}

function parseTimed(bytes: Buffer): OriginalTranscript | undefined {
  try {
    const item = record(JSON.parse(bytes.toString("utf8")));
    if (item?.representation !== "timed" || !Array.isArray(item.segments) || typeof item.text !== "string") return undefined;
    const original = normalizeOriginalTranscript({ text: item.text, segments: item.segments });
    return original?.timing === "available" ? original : undefined;
  } catch {
    return undefined;
  }
}

function parseAnalysis(bytes: Buffer, original: OriginalTranscript): AnalysisTranscript | undefined {
  const text = bytes.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    const item = record(parsed);
    if (item?.representation === "analysis" && typeof item.text === "string" && Array.isArray(item.segments)) {
      const segments = item.segments.flatMap((segment): AnalysisTranscript["segments"] => {
        const value = record(segment);
        if (value === undefined || typeof value.source_segment_id !== "string" || typeof value.text !== "string") return [];
        const start = typeof value.start_seconds === "number" && Number.isFinite(value.start_seconds) ? value.start_seconds : undefined;
        const duration = typeof value.duration_seconds === "number" && Number.isFinite(value.duration_seconds) ? value.duration_seconds : undefined;
        return [{
          source_segment_id: value.source_segment_id,
          text: value.text,
          ...(start === undefined ? {} : { start_seconds: start }),
          ...(duration === undefined ? {} : { duration_seconds: duration }),
        }];
      });
      if (segments.length === item.segments.length) {
        return {
          representation: "analysis",
          text: item.text,
          timing: item.timing === "available" ? "available" : "unavailable",
          source_variant: item.source_variant === "timed" ? "timed" : "untimed",
          segments,
        };
      }
    }
  } catch {
    // Older analysis objects were plain text. Reconstruct a safe untimed view.
  }
  const fallback = normalizeOriginalTranscript({ text });
  return fallback === undefined ? undefined : createAnalysisTranscript(fallback, fallback.segments.map((segment) => segment.segment_id));
}

function defaultFiltering(original: OriginalTranscript): TranscriptFilteringProvenance {
  return {
    outcome: "not_attempted",
    reason: "not_attempted",
    lookup_state: "not_attempted",
    timing: original.timing,
    boundary_policy: "exclude_wholly_contained_preserve_partial_overlap",
    original_segment_count: original.segments.length,
    retained_segment_count: original.segments.length,
    excluded_segment_count: 0,
    excluded_segment_ids: [],
    interval_ids: [],
  };
}

function initialMetadata(
  originalArtifact: TranscriptArtifactMetadata,
  currentTranscript: CurrentTranscriptProvenance,
  original: OriginalTranscript,
  timedArtifact?: TranscriptArtifactMetadata,
): TranscriptAnalysisMetadata {
  return {
    contract_version: TRANSCRIPT_ANALYSIS_CONTRACT_VERSION,
    current_transcript: currentTranscript,
    artifacts: { original: originalArtifact, ...(timedArtifact === undefined ? {} : { timed: timedArtifact }) },
    filtering: defaultFiltering(original),
  };
}

function contentWithTranscriptMetadata(content: ContentMetadata, transcriptAnalysis: TranscriptAnalysisMetadata): ContentMetadata {
  return {
    ...content,
    metadata: {
      ...content.metadata,
      transcript_analysis: jsonValue(transcriptAnalysis) as JsonObject,
    },
  };
}

function currentTranscriptFromContent(content: ContentMetadata, original: OriginalTranscript): CurrentTranscriptProvenance {
  const metadata = metadataValue(content);
  const existing = normalizeTranscriptAnalysisMetadata(metadata.transcript_analysis)?.current_transcript;
  if (existing !== undefined) return { ...existing, timing: original.timing };
  const videoId = stringValue(metadata.video_id);
  // A legacy content row may retain YouTube metadata without retaining how
  // its transcript was acquired. Do not infer current caption provenance from
  // that historical identifier.
  return {
    source_kind: "legacy_stored",
    ...(videoId === undefined ? {} : { video_id: videoId }),
    timing: original.timing,
  };
}

function publicationDate(content: ContentMetadata): string | null | undefined {
  const value = metadataValue(content).published_at;
  return value === null ? null : stringValue(value);
}

function videoDuration(content: ContentMetadata): number | null | undefined {
  const value = metadataValue(content).duration_seconds;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function videoId(content: ContentMetadata, current: CurrentTranscriptProvenance): string | undefined {
  return stringValue(current.video_id) ?? stringValue(metadataValue(content).video_id);
}

function changedMetadata(left: TranscriptAnalysisMetadata | undefined, right: TranscriptAnalysisMetadata): boolean {
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** Stores the structured source representations at content-owned object keys. */
export async function storeTranscriptArtifacts(
  storage: TranscriptArtifactStorage,
  objectKey: string,
  original: OriginalTranscript,
  createdAt = new Date(),
): Promise<TranscriptArtifactSet> {
  if (objectKey.trim() === "") throw new Error("transcript object key must not be empty");
  const created = isoDate(createdAt, new Date());
  const originalBytes = Buffer.from(serializeTranscript(original), "utf8");
  await storage.upload(objectKey, Readable.from(originalBytes), TRANSCRIPT_TEXT_CONTENT_TYPE);
  const result: TranscriptArtifactSet = {
    original: artifactWithDigest("original", objectKey, originalBytes, created, TRANSCRIPT_TEXT_CONTENT_TYPE),
  };
  const timed = toTimedTranscript(original);
  if (timed !== undefined) {
    const timedBytes = serializeRepresentation(timed);
    const timedKey = siblingObjectKey(objectKey, "timed");
    await storage.upload(timedKey, Readable.from(timedBytes), TRANSCRIPT_ARTIFACT_CONTENT_TYPE);
    result.timed = artifactWithDigest("timed", timedKey, timedBytes, created);
  }
  return result;
}

/** Stores only the compatibility/original artifact. */
export async function storeOriginalTranscript(
  storage: TranscriptArtifactStorage,
  objectKey: string,
  original: OriginalTranscript,
  createdAt = new Date(),
): Promise<TranscriptArtifactMetadata> {
  if (objectKey.trim() === "") throw new Error("transcript object key must not be empty");
  const bytes = Buffer.from(serializeTranscript(original), "utf8");
  await storage.upload(objectKey, Readable.from(bytes), TRANSCRIPT_TEXT_CONTENT_TYPE);
  return artifactWithDigest("original", objectKey, bytes, isoDate(createdAt, new Date()), TRANSCRIPT_TEXT_CONTENT_TYPE);
}

/**
 * Resolves original or analysis transcript data without invoking the pipeline.
 * Missing analysis data may be materialized only during an explicit whole-
 * transcript access; lightweight metadata reads never call this resolver.
 */
export class TranscriptArtifactResolver implements WholeTranscriptResolver {
  private readonly sponsorblock: TranscriptSponsorBlock;

  constructor(private readonly options: TranscriptArtifactResolverOptions) {
    this.sponsorblock = options.sponsorblock ?? new SponsorBlockService();
  }

  async resolve(request: { content_id: string; variant: TranscriptDownloadVariant; access: WholeTranscriptAccess }): Promise<WholeTranscriptResolution> {
    const content = await this.options.repository.get_content(request.content_id);
    if (content === undefined) throw new Error(`content not found: ${request.content_id}`);
    const now = validNow(this.options.now);
    const stored = normalizeTranscriptAnalysisMetadata(metadataValue(content).transcript_analysis);
    const originalKey = stored?.artifacts.original.object_key ?? content.file_path;
    const originalBytes = await this.options.storage.download(originalKey);
    let original = parseOriginal(originalBytes);
    if (original?.timing !== "available" && stored?.artifacts.timed !== undefined) {
      const timed = parseTimed(await this.options.storage.download(stored.artifacts.timed.object_key));
      if (timed !== undefined) original = timed;
    }
    if (original === undefined) throw new Error(`stored transcript is invalid: ${request.content_id}`);
    const currentTranscript = currentTranscriptFromContent(content, original);
    const originalArtifact = stored?.artifacts.original ?? artifactWithDigest("original", originalKey, originalBytes, isoDate(content.updated_at, now), content.mime_type);
    let metadata = stored;
    if (metadata === undefined || metadata.artifacts.original.object_key !== originalArtifact.object_key || metadata.current_transcript.timing !== currentTranscript.timing) {
      metadata = initialMetadata(originalArtifact, currentTranscript, original);
    } else if (metadata.artifacts.original.sha256 === undefined || metadata.artifacts.original.byte_length !== originalArtifact.byte_length) {
      metadata = { ...metadata, artifacts: { ...metadata.artifacts, original: originalArtifact } };
    }

    if (request.variant === "original") {
      if (changedMetadata(stored, metadata)) await this.options.repository.update_content(request.content_id, contentWithTranscriptMetadata(content, metadata));
      return {
        content_id: request.content_id,
        variant: request.variant,
        transcript: original,
        artifact: metadata.artifacts.original,
        current_transcript: metadata.current_transcript,
        ...(metadata.sponsorblock === undefined ? {} : { sponsorblock: metadata.sponsorblock }),
        filtering: metadata.filtering,
      };
    }

    const currentVideoId = videoId(content, currentTranscript);
    let lookup: SponsorBlockLookupProvenance = metadata.sponsorblock ?? { state: "not_attempted" };
    const duration = videoDuration(content);
    const canLookup = original.timing === "available" && currentVideoId !== undefined;
    if (canLookup && !isSponsorBlockLookupReusable(lookup, currentVideoId, now, duration)) {
      lookup = await this.sponsorblock.lookup(currentVideoId, {
        existing: lookup,
        publicationDate: publicationDate(content),
        videoDurationSeconds: duration,
      });
    } else if (!canLookup) {
      lookup = { state: "not_attempted" };
    }

    const cachedAnalysis = metadata.artifacts.analysis;
    const cachedFiltering = metadata.filtering;
    const cachedAnalysisUsable = cachedAnalysis !== undefined
      && cachedFiltering.lookup_state === lookup.state
      && (cachedFiltering.timing === original.timing);
    let analysis: AnalysisTranscript | undefined;
    let analysisArtifact = cachedAnalysis;
    let filtering: TranscriptFilteringProvenance;
    if (cachedAnalysisUsable && cachedAnalysis !== undefined) {
      analysis = parseAnalysis(await this.options.storage.download(cachedAnalysis.object_key), original);
      filtering = cachedFiltering;
    }
    if (analysis === undefined) {
      const filtered = filterTranscriptForAnalysis(original, lookup, { videoDurationSeconds: duration });
      analysis = filtered.analysis;
      filtering = filtered.filtering;
      const bytes = serializeRepresentation(analysis);
      const objectKey = cachedAnalysis?.object_key ?? analysisObjectKey(originalKey);
      await this.options.storage.upload(objectKey, Readable.from(bytes), TRANSCRIPT_ARTIFACT_CONTENT_TYPE);
      analysisArtifact = artifactWithDigest("analysis", objectKey, bytes, now.toISOString());
    } else {
      filtering = cachedFiltering;
    }

    metadata = {
      ...metadata,
      artifacts: {
        ...metadata.artifacts,
        original: originalArtifact,
        ...(analysisArtifact === undefined ? {} : { analysis: analysisArtifact }),
      } as TranscriptArtifactSet,
      sponsorblock: lookup,
      filtering,
    };
    if (changedMetadata(stored, metadata)) await this.options.repository.update_content(request.content_id, contentWithTranscriptMetadata(content, metadata));
    if (analysisArtifact === undefined) throw new Error(`analysis artifact was not created: ${request.content_id}`);
    return {
      content_id: request.content_id,
      variant: request.variant,
      transcript: analysis,
      artifact: analysisArtifact,
      current_transcript: metadata.current_transcript,
      sponsorblock: lookup,
      filtering,
    };
  }
}

export type TranscriptResolver = TranscriptArtifactResolver;
export const createTranscriptResolver = (options: TranscriptArtifactResolverOptions): WholeTranscriptResolver => new TranscriptArtifactResolver(options);

export function transcriptMetadataForIngest(
  originalArtifact: TranscriptArtifactMetadata,
  currentTranscript: CurrentTranscriptProvenance,
  original: OriginalTranscript,
  timedArtifact?: TranscriptArtifactMetadata,
): JsonObject {
  return jsonValue(initialMetadata(originalArtifact, currentTranscript, original, timedArtifact)) as JsonObject;
}

export function transcriptResponseText(resolution: WholeTranscriptResolution): string {
  return serializeTranscript(resolution.transcript);
}

export const TRANSCRIPT_ARTIFACT_MIME_TYPE = TRANSCRIPT_ARTIFACT_CONTENT_TYPE;
export const TRANSCRIPT_DOWNLOAD_MIME_TYPE = TRANSCRIPT_TEXT_CONTENT_TYPE;
