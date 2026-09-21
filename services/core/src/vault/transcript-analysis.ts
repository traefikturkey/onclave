export const TRANSCRIPT_ANALYSIS_CONTRACT_VERSION = 1 as const;
export const SUMMARY_CONTRACT_VERSION = 1 as const;
export const OUTLINE_CONTRACT_VERSION = 1 as const;

export type TranscriptTimestamp = string;
export type TranscriptVariant = "original" | "timed" | "analysis";
export type TranscriptDownloadVariant = "original" | "analysis";
export type TranscriptTiming = "available" | "unavailable";

export type TranscriptSourceKind = "youtube_captions" | "user_supplied" | "legacy_stored";

export type CurrentTranscriptProvenance = {
  source_kind: TranscriptSourceKind;
  video_id?: string | null;
  language?: string | null;
  captured_at?: TranscriptTimestamp | null;
  timing: TranscriptTiming;
};

export type TimedTranscriptSegment = {
  segment_id: string;
  text: string;
  start_seconds: number;
  duration_seconds: number;
};

export type UntimedTranscriptSegment = {
  segment_id: string;
  text: string;
};

export type OriginalTranscript = {
  representation: "original";
  text: string;
  timing: TranscriptTiming;
  segments: Array<TimedTranscriptSegment | UntimedTranscriptSegment>;
  provenance?: CurrentTranscriptProvenance;
};

export type TimedTranscript = {
  representation: "timed";
  text: string;
  segments: TimedTranscriptSegment[];
  source_variant: "original";
};

export type AnalysisTranscriptSegment = {
  source_segment_id: string;
  text: string;
  start_seconds?: number;
  duration_seconds?: number;
};

export type AnalysisTranscript = {
  representation: "analysis";
  text: string;
  timing: TranscriptTiming;
  source_variant: "timed" | "untimed";
  segments: AnalysisTranscriptSegment[];
};

export type TranscriptRepresentation = OriginalTranscript | TimedTranscript | AnalysisTranscript;

export type SponsorBlockAttribution = {
  service: "SponsorBlock";
  source_url: "https://sponsor.ajay.app/";
  license: "CC BY-NC-SA 4.0";
};

export const SPONSORBLOCK_ATTRIBUTION: SponsorBlockAttribution = {
  service: "SponsorBlock",
  source_url: "https://sponsor.ajay.app/",
  license: "CC BY-NC-SA 4.0",
};

export type SponsorBlockInterval = {
  id: string;
  category: "sponsor";
  action: "skip";
  start_seconds: number;
  end_seconds: number;
  video_duration_seconds?: number | null;
};

export type SponsorBlockNegativeCache = {
  publication_date: TranscriptTimestamp | null;
  looked_up_at: TranscriptTimestamp;
  retry_eligible_at: TranscriptTimestamp;
};

type SponsorBlockLookupBase = {
  source: SponsorBlockAttribution;
  video_id: string;
  looked_up_at: TranscriptTimestamp;
  publication_date?: TranscriptTimestamp | null;
  video_duration_seconds?: number | null;
};

export type SponsorBlockLookupProvenance =
  | { state: "not_attempted" }
  | (SponsorBlockLookupBase & {
      state: "matched";
      intervals: SponsorBlockInterval[];
    })
  | (SponsorBlockLookupBase & {
      state: "empty";
      intervals: [];
      negative_cache: SponsorBlockNegativeCache;
    })
  | (SponsorBlockLookupBase & {
      state: "unavailable";
      error_code?: string;
    });

export type TranscriptFilterOutcome =
  | "filtered"
  | "unchanged"
  | "incompatible_intervals"
  | "timing_unavailable"
  | "not_attempted";

export type TranscriptFilterReason =
  | "sponsor_intervals_applied"
  | "no_sponsor_matches"
  | "lookup_unavailable"
  | "incompatible_intervals"
  | "transcript_timing_unavailable"
  | "not_attempted"
  | "legacy_unknown";

export type TranscriptFilteringProvenance = {
  outcome: TranscriptFilterOutcome;
  reason: TranscriptFilterReason;
  lookup_state: SponsorBlockLookupProvenance["state"];
  timing: TranscriptTiming;
  boundary_policy: "exclude_wholly_contained_preserve_partial_overlap";
  original_segment_count: number | null;
  retained_segment_count: number | null;
  excluded_segment_count: number | null;
  excluded_segment_ids: string[];
  interval_ids: string[];
};

export type TranscriptArtifactSource = "original_transcript" | "timed_transcript" | "analysis_transcript";

export type TranscriptArtifactMetadata = {
  variant: TranscriptVariant;
  object_key: string;
  mime_type: string;
  byte_length: number;
  sha256?: string | null;
  created_at: TranscriptTimestamp;
  source: TranscriptArtifactSource;
};

export type TranscriptArtifactSet = {
  original: TranscriptArtifactMetadata;
  timed?: TranscriptArtifactMetadata;
  analysis?: TranscriptArtifactMetadata;
};

export type HistoricalArtifactKind = "summary" | "outline" | "embedding_index";
export type HistoricalArtifactState = "current" | "legacy" | "unknown";

export type HistoricalArtifactProvenance = {
  artifact: HistoricalArtifactKind;
  state: HistoricalArtifactState;
  source_variant: TranscriptVariant | "unknown";
  generated_at?: TranscriptTimestamp | null;
  source_range_count?: number | null;
  source_chunk_count?: number | null;
};

export type TranscriptAnalysisMetadata = {
  contract_version: typeof TRANSCRIPT_ANALYSIS_CONTRACT_VERSION;
  current_transcript: CurrentTranscriptProvenance;
  artifacts: TranscriptArtifactSet;
  sponsorblock?: SponsorBlockLookupProvenance;
  filtering: TranscriptFilteringProvenance;
  historical_artifacts?: HistoricalArtifactProvenance[];
};

export type CanonicalSummary = {
  version: typeof SUMMARY_CONTRACT_VERSION;
  overview: string;
  key_points: string[];
};

export type OutlineSource = {
  segment_ids?: string[];
  start_seconds?: number;
  end_seconds?: number;
};

export type OutlineSection = {
  heading: string;
  description: string;
  source?: OutlineSource;
};

export type VersionedOutline = {
  version: typeof OUTLINE_CONTRACT_VERSION;
  sections: OutlineSection[];
};

export type SummaryGenerationMethod = "single_call" | "map_reduce" | "no_retained_content" | "legacy" | "unknown";

export type FullSummaryCoverage = {
  status: "full";
  source_variant: "analysis";
  generation_method: "single_call" | "map_reduce" | "no_retained_content";
  source_segment_count: number;
  source_range_count: number;
  analyzed_segment_count: number;
  analyzed_range_count: number;
  analyzed_chunk_count: number;
};

export type PartialSummaryCoverage = {
  status: "partial";
  source_variant: TranscriptVariant | "unknown";
  generation_method: Exclude<SummaryGenerationMethod, "no_retained_content">;
  source_segment_count?: number;
  source_range_count?: number;
  analyzed_segment_count?: number;
  analyzed_range_count?: number;
  analyzed_chunk_count?: number;
};

export type LegacySummaryCoverage = {
  status: "legacy";
  source_variant: TranscriptVariant | "unknown";
  generation_method: "legacy";
  source_segment_count?: number;
  source_range_count?: number;
  analyzed_segment_count?: number;
  analyzed_range_count?: number;
  analyzed_chunk_count?: number;
};

export type UnknownSummaryCoverage = {
  status: "unknown";
  source_variant: "unknown";
  generation_method: "unknown";
};

export type SummaryCoverage = FullSummaryCoverage | PartialSummaryCoverage | LegacySummaryCoverage | UnknownSummaryCoverage;

export type TranscriptDownloadRequest = {
  content_id: string;
  variant?: TranscriptDownloadVariant;
};

export type TranscriptFilteringSummary = Pick<
  TranscriptFilteringProvenance,
  "outcome" | "reason" | "lookup_state" | "timing" | "retained_segment_count" | "excluded_segment_count"
>;

export type TranscriptDownloadResponse = {
  content_id: string;
  variant: TranscriptDownloadVariant;
  artifact: TranscriptArtifactMetadata;
  filtering: TranscriptFilteringSummary;
};

export type WholeTranscriptAccess = "ingest" | "process" | "reprocess" | "embedding_reindex" | "download";

export type WholeTranscriptResolveRequest = {
  content_id: string;
  variant: TranscriptDownloadVariant;
  access: WholeTranscriptAccess;
};

export type WholeTranscriptResolution = {
  content_id: string;
  variant: TranscriptDownloadVariant;
  transcript: OriginalTranscript | AnalysisTranscript;
  artifact: TranscriptArtifactMetadata;
  current_transcript: CurrentTranscriptProvenance;
  sponsorblock?: SponsorBlockLookupProvenance;
  filtering: TranscriptFilteringProvenance;
};

export interface WholeTranscriptResolver {
  resolve(request: WholeTranscriptResolveRequest): Promise<WholeTranscriptResolution>;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function optionalString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return nonEmptyString(value);
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function positiveCount(value: unknown): number | null | undefined {
  if (value === null) return null;
  const count = finiteNonNegative(value);
  return count === undefined || !Number.isInteger(count) ? undefined : count;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = nonEmptyString(item);
    return text === undefined ? [] : [text];
  });
}

function transcriptText(segments: readonly { text: string }[]): string {
  return segments.map((segment) => segment.text).join(" ");
}

function normalizeTimedSegment(value: unknown, index: number): TimedTranscriptSegment | UntimedTranscriptSegment | undefined {
  const item = record(value);
  const text = item === undefined || typeof item.text !== "string" ? undefined : item.text;
  if (text === undefined) return undefined;
  const segmentId = nonEmptyString(item?.segment_id ?? item?.id) ?? `segment-${index + 1}`;
  const start = finiteNonNegative(item?.start_seconds ?? item?.start);
  const duration = finiteNonNegative(item?.duration_seconds ?? item?.duration);
  if (start !== undefined && duration !== undefined) {
    return { segment_id: segmentId, text, start_seconds: start, duration_seconds: duration };
  }
  return { segment_id: segmentId, text };
}

export function normalizeOriginalTranscript(value: unknown): OriginalTranscript | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const rawSegments = Array.isArray(item.segments) ? item.segments : [];
  const segments = rawSegments.flatMap((segment, index) => {
    const normalized = normalizeTimedSegment(segment, index);
    return normalized === undefined ? [] : [normalized];
  });
  const rawText = typeof item.text === "string" ? item.text : typeof item.full_text === "string" ? item.full_text : undefined;
  if (rawText === undefined && segments.length === 0) return undefined;
  const text = rawText ?? transcriptText(segments);
  const effectiveSegments = segments.length === 0 && text !== "" ? [{ segment_id: "segment-1", text }] : segments;
  const timing: TranscriptTiming = effectiveSegments.length > 0 && effectiveSegments.every((segment): segment is TimedTranscriptSegment => "start_seconds" in segment && "duration_seconds" in segment)
    ? "available"
    : "unavailable";
  return {
    representation: "original",
    text,
    timing,
    segments: effectiveSegments,
  };
}

export function toTimedTranscript(original: OriginalTranscript): TimedTranscript | undefined {
  if (original.timing !== "available") return undefined;
  const segments = original.segments.filter((segment): segment is TimedTranscriptSegment => "start_seconds" in segment && "duration_seconds" in segment);
  if (segments.length !== original.segments.length) return undefined;
  return { representation: "timed", text: original.text, segments, source_variant: "original" };
}

/** Builds the analysis representation from retained source segments without restoring excluded text. */
export function createAnalysisTranscript(
  original: OriginalTranscript,
  retainedSegmentIds: readonly string[],
): AnalysisTranscript {
  const retained = new Set(retainedSegmentIds);
  const segments = original.segments
    .filter((segment) => retained.has(segment.segment_id))
    .map((segment) => "start_seconds" in segment && "duration_seconds" in segment
      ? { source_segment_id: segment.segment_id, text: segment.text, start_seconds: segment.start_seconds, duration_seconds: segment.duration_seconds }
      : { source_segment_id: segment.segment_id, text: segment.text });
  return {
    representation: "analysis",
    text: transcriptText(segments),
    timing: original.timing,
    source_variant: original.timing === "available" ? "timed" : "untimed",
    segments,
  };
}

export function serializeTranscript(transcript: TranscriptRepresentation): string {
  return transcript.text;
}

function normalizeAttribution(_value: unknown): SponsorBlockAttribution {
  return SPONSORBLOCK_ATTRIBUTION;
}

function normalizeSponsorInterval(value: unknown): SponsorBlockInterval | undefined {
  const item = record(value);
  const id = nonEmptyString(item?.id ?? item?.UUID);
  const category = nonEmptyString(item?.category);
  const action = nonEmptyString(item?.action ?? item?.actionType);
  const start = finiteNonNegative(item?.start_seconds ?? (Array.isArray(item?.segment) ? item.segment[0] : undefined));
  const end = finiteNonNegative(item?.end_seconds ?? (Array.isArray(item?.segment) ? item.segment[1] : undefined));
  if (id === undefined || category !== "sponsor" || action !== "skip" || start === undefined || end === undefined || end <= start) return undefined;
  const videoDuration = finiteNonNegative(item?.video_duration_seconds ?? item?.videoDuration);
  return {
    id,
    category: "sponsor",
    action: "skip",
    start_seconds: start,
    end_seconds: end,
    ...(videoDuration === undefined ? {} : { video_duration_seconds: videoDuration }),
  };
}

function normalizeLookupBase(item: RecordValue): SponsorBlockLookupBase | undefined {
  const videoId = nonEmptyString(item.video_id ?? item.videoID);
  const lookedUpAt = nonEmptyString(item.looked_up_at ?? item.lookup_at);
  if (videoId === undefined || lookedUpAt === undefined) return undefined;
  const publicationDate = optionalString(item.publication_date ?? item.published_at);
  const videoDuration = finiteNonNegative(item.video_duration_seconds ?? item.videoDuration);
  return {
    source: normalizeAttribution(item.source),
    video_id: videoId,
    looked_up_at: lookedUpAt,
    ...(publicationDate === null ? { publication_date: null } : publicationDate === undefined ? {} : { publication_date: publicationDate }),
    ...(videoDuration === undefined ? {} : { video_duration_seconds: videoDuration }),
  };
}

function normalizeNegativeCache(value: unknown): SponsorBlockNegativeCache | undefined {
  const item = record(value);
  const lookedUpAt = nonEmptyString(item?.looked_up_at);
  const retryEligibleAt = nonEmptyString(item?.retry_eligible_at);
  if (lookedUpAt === undefined || retryEligibleAt === undefined) return undefined;
  const publicationDate = optionalString(item?.publication_date);
  return {
    publication_date: publicationDate ?? null,
    looked_up_at: lookedUpAt,
    retry_eligible_at: retryEligibleAt,
  };
}

export function normalizeSponsorBlockLookup(value: unknown): SponsorBlockLookupProvenance | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  if (item.state === "not_attempted") return { state: "not_attempted" };
  const base = normalizeLookupBase(item);
  if (base === undefined) return undefined;
  if (item.state === "matched") {
    return { ...base, state: "matched", intervals: Array.isArray(item.intervals) ? item.intervals.flatMap((interval) => {
      const normalized = normalizeSponsorInterval(interval);
      return normalized === undefined ? [] : [normalized];
    }) : [] };
  }
  if (item.state === "empty") {
    const negativeCache = normalizeNegativeCache(item.negative_cache);
    if (negativeCache === undefined) return undefined;
    return { ...base, state: "empty", intervals: [], negative_cache: negativeCache };
  }
  if (item.state === "unavailable") {
    const errorCode = nonEmptyString(item.error_code);
    return { ...base, state: "unavailable", ...(errorCode === undefined ? {} : { error_code: errorCode }) };
  }
  return undefined;
}

export function normalizeTranscriptFiltering(value: unknown): TranscriptFilteringProvenance | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const outcomes: TranscriptFilterOutcome[] = ["filtered", "unchanged", "incompatible_intervals", "timing_unavailable", "not_attempted"];
  const reasons: TranscriptFilterReason[] = ["sponsor_intervals_applied", "no_sponsor_matches", "lookup_unavailable", "incompatible_intervals", "transcript_timing_unavailable", "not_attempted", "legacy_unknown"];
  const lookupStates: SponsorBlockLookupProvenance["state"][] = ["not_attempted", "matched", "empty", "unavailable"];
  const outcome = outcomes.includes(item.outcome as TranscriptFilterOutcome) ? item.outcome as TranscriptFilterOutcome : undefined;
  const reason = reasons.includes(item.reason as TranscriptFilterReason) ? item.reason as TranscriptFilterReason : undefined;
  const lookupState = lookupStates.includes(item.lookup_state as SponsorBlockLookupProvenance["state"]) ? item.lookup_state as SponsorBlockLookupProvenance["state"] : undefined;
  const timing = item.timing === "available" || item.timing === "unavailable" ? item.timing : undefined;
  if (outcome === undefined || reason === undefined || lookupState === undefined || timing === undefined || item.boundary_policy !== "exclude_wholly_contained_preserve_partial_overlap") return undefined;
  const originalCount = positiveCount(item.original_segment_count);
  const retainedCount = positiveCount(item.retained_segment_count);
  const excludedCount = positiveCount(item.excluded_segment_count);
  if (originalCount === undefined || retainedCount === undefined || excludedCount === undefined) return undefined;
  return {
    outcome,
    reason,
    lookup_state: lookupState,
    timing,
    boundary_policy: "exclude_wholly_contained_preserve_partial_overlap",
    original_segment_count: originalCount,
    retained_segment_count: retainedCount,
    excluded_segment_count: excludedCount,
    excluded_segment_ids: stringArray(item.excluded_segment_ids),
    interval_ids: stringArray(item.interval_ids),
  };
}

function normalizeCurrentTranscriptProvenance(value: unknown): CurrentTranscriptProvenance | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const sourceKinds: TranscriptSourceKind[] = ["youtube_captions", "user_supplied", "legacy_stored"];
  if (!sourceKinds.includes(item.source_kind as TranscriptSourceKind)) return undefined;
  if (item.timing !== "available" && item.timing !== "unavailable") return undefined;
  const videoId = optionalString(item.video_id);
  const language = optionalString(item.language);
  const capturedAt = optionalString(item.captured_at);
  return {
    source_kind: item.source_kind as TranscriptSourceKind,
    timing: item.timing,
    ...(videoId === null ? { video_id: null } : videoId === undefined ? {} : { video_id: videoId }),
    ...(language === null ? { language: null } : language === undefined ? {} : { language }),
    ...(capturedAt === null ? { captured_at: null } : capturedAt === undefined ? {} : { captured_at: capturedAt }),
  };
}

function normalizeArtifact(value: unknown, expectedVariant?: TranscriptVariant): TranscriptArtifactMetadata | undefined {
  const item = record(value);
  const variant = item?.variant;
  const variants: TranscriptVariant[] = ["original", "timed", "analysis"];
  const objectKey = nonEmptyString(item?.object_key);
  const mimeType = nonEmptyString(item?.mime_type);
  const byteLength = positiveCount(item?.byte_length);
  const createdAt = nonEmptyString(item?.created_at);
  const sourceKinds: TranscriptArtifactSource[] = ["original_transcript", "timed_transcript", "analysis_transcript"];
  if (!variants.includes(variant as TranscriptVariant) || (expectedVariant !== undefined && variant !== expectedVariant) || objectKey === undefined || mimeType === undefined || byteLength === undefined || byteLength === null || createdAt === undefined || !sourceKinds.includes(item?.source as TranscriptArtifactSource)) return undefined;
  const sha256 = optionalString(item?.sha256);
  return {
    variant: variant as TranscriptVariant,
    object_key: objectKey,
    mime_type: mimeType,
    byte_length: byteLength,
    created_at: createdAt,
    source: item?.source as TranscriptArtifactSource,
    ...(sha256 === null ? { sha256: null } : sha256 === undefined ? {} : { sha256 }),
  };
}

function normalizeArtifacts(value: unknown): TranscriptArtifactSet | undefined {
  const item = record(value);
  const original = normalizeArtifact(item?.original, "original");
  if (original === undefined) return undefined;
  const timed = item?.timed === undefined ? undefined : normalizeArtifact(item.timed, "timed");
  const analysis = item?.analysis === undefined ? undefined : normalizeArtifact(item.analysis, "analysis");
  if (item?.timed !== undefined && timed === undefined) return undefined;
  if (item?.analysis !== undefined && analysis === undefined) return undefined;
  return { original, ...(timed === undefined ? {} : { timed }), ...(analysis === undefined ? {} : { analysis }) };
}

function normalizeHistoricalArtifact(value: unknown): HistoricalArtifactProvenance | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const artifactKinds: HistoricalArtifactKind[] = ["summary", "outline", "embedding_index"];
  const states: HistoricalArtifactState[] = ["current", "legacy", "unknown"];
  const variants: Array<TranscriptVariant | "unknown"> = ["original", "timed", "analysis", "unknown"];
  if (!artifactKinds.includes(item?.artifact as HistoricalArtifactKind) || !states.includes(item?.state as HistoricalArtifactState) || !variants.includes(item?.source_variant as TranscriptVariant | "unknown")) return undefined;
  const generatedAt = optionalString(item?.generated_at);
  const sourceRangeCount = positiveCount(item?.source_range_count);
  const sourceChunkCount = positiveCount(item?.source_chunk_count);
  if (("source_range_count" in item && sourceRangeCount === undefined) || ("source_chunk_count" in item && sourceChunkCount === undefined)) return undefined;
  return {
    artifact: item?.artifact as HistoricalArtifactKind,
    state: item?.state as HistoricalArtifactState,
    source_variant: item?.source_variant as TranscriptVariant | "unknown",
    ...(generatedAt === null ? { generated_at: null } : generatedAt === undefined ? {} : { generated_at: generatedAt }),
    ...(sourceRangeCount === null || sourceRangeCount === undefined ? {} : { source_range_count: sourceRangeCount }),
    ...(sourceChunkCount === null || sourceChunkCount === undefined ? {} : { source_chunk_count: sourceChunkCount }),
  };
}

export function normalizeTranscriptAnalysisMetadata(value: unknown): TranscriptAnalysisMetadata | undefined {
  const item = record(value);
  if (item?.contract_version !== 1 && item?.contract_version !== "1") return undefined;
  const currentTranscript = normalizeCurrentTranscriptProvenance(item?.current_transcript);
  const artifacts = normalizeArtifacts(item?.artifacts);
  const filtering = normalizeTranscriptFiltering(item?.filtering);
  if (currentTranscript === undefined || artifacts === undefined || filtering === undefined) return undefined;
  const sponsorblock = item?.sponsorblock === undefined ? undefined : normalizeSponsorBlockLookup(item.sponsorblock);
  if (item?.sponsorblock !== undefined && sponsorblock === undefined) return undefined;
  const historicalArtifacts = item?.historical_artifacts === undefined ? undefined : Array.isArray(item.historical_artifacts) ? item.historical_artifacts.flatMap((artifact) => {
    const normalized = normalizeHistoricalArtifact(artifact);
    return normalized === undefined ? [] : [normalized];
  }) : undefined;
  if (item?.historical_artifacts !== undefined && historicalArtifacts === undefined) return undefined;
  return {
    contract_version: TRANSCRIPT_ANALYSIS_CONTRACT_VERSION,
    current_transcript: currentTranscript,
    artifacts,
    filtering,
    ...(sponsorblock === undefined ? {} : { sponsorblock }),
    ...(historicalArtifacts === undefined ? {} : { historical_artifacts: historicalArtifacts }),
  };
}

function normalizeCanonicalSummaryValue(value: unknown): CanonicalSummary | undefined {
  const item = record(value);
  if (item === undefined || (item.version !== 1 && item.version !== "1") || typeof item.overview !== "string" || !Array.isArray(item.key_points)) return undefined;
  const overview = item.overview.trim();
  const keyPoints = item.key_points.flatMap((point) => typeof point === "string" && point.trim() !== "" ? [point.trim()] : []);
  if (overview === "" || keyPoints.length === 0) return undefined;
  return { version: SUMMARY_CONTRACT_VERSION, overview, key_points: keyPoints };
}

export function normalizeCanonicalSummary(value: unknown): CanonicalSummary | undefined {
  return normalizeCanonicalSummaryValue(value);
}

export function legacySummaryFromCanonical(summary: CanonicalSummary): string {
  return [summary.overview, ...summary.key_points.map((point) => `- ${point}`)].join("\n\n");
}

function normalizeOutlineSource(value: unknown): OutlineSource | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const segmentIds = stringArray(item.segment_ids);
  const start = finiteNonNegative(item.start_seconds);
  const end = finiteNonNegative(item.end_seconds);
  if (start !== undefined && end !== undefined && end < start) return undefined;
  if (start === undefined && end === undefined && segmentIds.length === 0) return undefined;
  if ((start === undefined) !== (end === undefined)) return undefined;
  return {
    ...(segmentIds.length === 0 ? {} : { segment_ids: segmentIds }),
    ...(start === undefined || end === undefined ? {} : { start_seconds: start, end_seconds: end }),
  };
}

export function normalizeVersionedOutline(value: unknown): VersionedOutline | undefined {
  const item = record(value);
  if (item === undefined || (item.version !== 1 && item.version !== "1") || !Array.isArray(item.sections)) return undefined;
  const sections = item.sections.flatMap((section) => {
    const entry = record(section);
    const heading = nonEmptyString(entry?.heading);
    const description = nonEmptyString(entry?.description);
    if (heading === undefined || description === undefined) return [];
    if (entry?.source === undefined) return [{ heading, description }];
    const source = normalizeOutlineSource(entry.source);
    return source === undefined ? [{ heading, description }] : [{ heading, description, source }];
  });
  return { version: OUTLINE_CONTRACT_VERSION, sections };
}

function normalizeCoverage(value: unknown): SummaryCoverage | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const sourceVariants: Array<TranscriptVariant | "unknown"> = ["original", "timed", "analysis", "unknown"];
  const sourceVariant = sourceVariants.includes(item.source_variant as TranscriptVariant | "unknown") ? item.source_variant as TranscriptVariant | "unknown" : undefined;
  const method: SummaryGenerationMethod | undefined = ["single_call", "map_reduce", "no_retained_content", "legacy", "unknown"].includes(item.generation_method as SummaryGenerationMethod) ? item.generation_method as SummaryGenerationMethod : undefined;
  const count = (name: string): number | undefined => {
    const value = positiveCount(item[name]);
    return value === null ? undefined : value;
  };
  if (sourceVariant === undefined || method === undefined) return undefined;
  const counts = {
    source_segment_count: count("source_segment_count"),
    source_range_count: count("source_range_count"),
    analyzed_segment_count: count("analyzed_segment_count"),
    analyzed_range_count: count("analyzed_range_count"),
    analyzed_chunk_count: count("analyzed_chunk_count"),
  };
  if (Object.values(counts).some((value) => value !== undefined && !Number.isInteger(value))) return undefined;
  if (item.status === "full") {
    if (sourceVariant !== "analysis" || !["single_call", "map_reduce", "no_retained_content"].includes(method) || Object.values(counts).some((value) => value === undefined)) return undefined;
    return { status: "full", source_variant: "analysis", generation_method: method as FullSummaryCoverage["generation_method"], source_segment_count: counts.source_segment_count as number, source_range_count: counts.source_range_count as number, analyzed_segment_count: counts.analyzed_segment_count as number, analyzed_range_count: counts.analyzed_range_count as number, analyzed_chunk_count: counts.analyzed_chunk_count as number };
  }
  if (item.status === "partial" && method !== "no_retained_content" && method !== "unknown") return { status: "partial", source_variant: sourceVariant, generation_method: method, ...counts };
  if (item.status === "legacy" && method === "legacy") return { status: "legacy", source_variant: sourceVariant, generation_method: method, ...counts };
  if (item.status === "unknown" && sourceVariant === "unknown" && method === "unknown") return { status: "unknown", source_variant: "unknown", generation_method: "unknown" };
  return undefined;
}

export type NormalizedStoredSummary = {
  summary?: string;
  structured_summary?: CanonicalSummary;
  outline?: VersionedOutline;
  summary_coverage?: SummaryCoverage;
};

/** Reads both the old scalar shape and the additive canonical shape. */
export function normalizeStoredSummary(value: unknown): NormalizedStoredSummary | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  const canonical = normalizeCanonicalSummaryValue(item.structured_summary);
  const outline = item.outline === undefined ? undefined : normalizeVersionedOutline(item.outline);
  const coverage = item.summary_coverage === undefined ? undefined : normalizeCoverage(item.summary_coverage);
  if (item.outline !== undefined && outline === undefined) return undefined;
  if (item.summary_coverage !== undefined && coverage === undefined) return undefined;
  const scalar = canonical === undefined ? typeof item.summary === "string" ? item.summary : undefined : legacySummaryFromCanonical(canonical);
  if (canonical === undefined && scalar === undefined && outline === undefined && coverage === undefined) return undefined;
  return {
    ...(scalar === undefined ? {} : { summary: scalar }),
    ...(canonical === undefined ? {} : { structured_summary: canonical }),
    ...(outline === undefined ? {} : { outline }),
    ...(coverage === undefined ? {} : { summary_coverage: coverage }),
  };
}