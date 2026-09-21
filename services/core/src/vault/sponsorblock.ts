import { createHash } from "node:crypto";
import {
  createAnalysisTranscript,
  SPONSORBLOCK_ATTRIBUTION,
  type OriginalTranscript,
  type SponsorBlockInterval,
  type SponsorBlockLookupProvenance,
  type TranscriptFilteringProvenance,
} from "./transcript-analysis";

export const SPONSORBLOCK_API_BASE_URL = "https://sponsor.ajay.app/api/skipSegments";
export const SPONSORBLOCK_HASH_PREFIX_LENGTH = 4;
export const SPONSORBLOCK_DURATION_TOLERANCE_SECONDS = 5;
export const SPONSORBLOCK_YOUNG_VIDEO_DAYS = 7;
export const SPONSORBLOCK_YOUNG_RETRY_DAYS = 1;
export const SPONSORBLOCK_OLD_RETRY_DAYS = 30;
export const SPONSORBLOCK_DEFAULT_TIMEOUT_MS = 5000;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export type SponsorBlockFetchInit = {
  signal?: AbortSignal;
  headers?: Record<string, string>;
};

export type SponsorBlockFetchResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type SponsorBlockFetcher = (url: string, init?: SponsorBlockFetchInit) => Promise<SponsorBlockFetchResponse>;

export type SponsorBlockClock = () => Date;

export type SponsorBlockLookupOptions = {
  fetcher?: SponsorBlockFetcher;
  now?: SponsorBlockClock;
  clock?: SponsorBlockClock;
  timeoutMs?: number;
  signal?: AbortSignal;
  publicationDate?: string | null;
  videoDurationSeconds?: number | null;
  existing?: SponsorBlockLookupProvenance;
  stored?: SponsorBlockLookupProvenance;
};

export type SponsorBlockFilterOptions = {
  videoDurationSeconds?: number | null;
  durationSeconds?: number | null;
};

export type SponsorBlockFilterResult = {
  analysis: ReturnType<typeof createAnalysisTranscript>;
  filtering: TranscriptFilteringProvenance;
  retained_segment_ids: string[];
};

function defaultClock(): Date {
  return new Date();
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asDate(value: string | Date | undefined | null): Date | undefined {
  const date = value instanceof Date ? new Date(value.getTime()) : value === undefined || value === null ? undefined : new Date(value);
  return date !== undefined && Number.isFinite(date.getTime()) ? date : undefined;
}

function nowFrom(options: Pick<SponsorBlockLookupOptions, "now" | "clock">): Date {
  const date = (options.now ?? options.clock ?? defaultClock)();
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError("SponsorBlock clock returned an invalid date");
  return new Date(date.getTime());
}

/** Returns the lowercase SHA-256 prefix used to select a SponsorBlock bucket. */
export function sponsorBlockHashPrefix(videoId: string, length = SPONSORBLOCK_HASH_PREFIX_LENGTH): string {
  if (videoId.trim() === "") throw new TypeError("videoId must not be empty");
  if (!Number.isInteger(length) || length < 1 || length > 64) throw new RangeError("invalid SponsorBlock hash prefix length");
  return createHash("sha256").update(videoId, "utf8").digest("hex").slice(0, length);
}

export const hashPrefixForVideo = sponsorBlockHashPrefix;

export function sponsorBlockLookupUrl(videoId: string): string {
  const prefix = sponsorBlockHashPrefix(videoId);
  return `${SPONSORBLOCK_API_BASE_URL}/${prefix}?categories=sponsor&actionTypes=skip`;
}

function durationCompatible(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined || right === undefined) return true;
  return Math.abs(left - right) <= SPONSORBLOCK_DURATION_TOLERANCE_SECONDS;
}

export function areSponsorBlockDurationsCompatible(
  expectedDurationSeconds: number | null | undefined,
  observedDurationSeconds: number | null | undefined,
): boolean {
  const expected = finiteNonNegative(expectedDurationSeconds);
  const observed = finiteNonNegative(observedDurationSeconds);
  return durationCompatible(expected, observed);
}

type RawInterval = {
  id: string;
  category: "sponsor";
  action: "skip";
  start_seconds: number;
  end_seconds: number;
  video_duration_seconds?: number;
};

function rawInterval(value: unknown, videoDurationSeconds?: number): RawInterval | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const id = nonEmptyString(item.id ?? item.UUID);
  const category = item.category;
  const action = item.action ?? item.actionType;
  const segment = Array.isArray(item.segment) ? item.segment : undefined;
  const start = finiteNonNegative(item.start_seconds ?? segment?.[0]);
  const end = finiteNonNegative(item.end_seconds ?? segment?.[1]);
  if (id === undefined || category !== "sponsor" || action !== "skip" || start === undefined || end === undefined || end <= start) return undefined;
  const observedDuration = finiteNonNegative(item.video_duration_seconds ?? item.videoDuration);
  if (!durationCompatible(videoDurationSeconds, observedDuration)) return undefined;
  // An interval outside the referenced video cannot be applied safely.
  if (videoDurationSeconds !== undefined && (start > videoDurationSeconds || end > videoDurationSeconds)) return undefined;
  return {
    id,
    category: "sponsor",
    action: "skip",
    start_seconds: start,
    end_seconds: end,
    ...(observedDuration === undefined ? {} : { video_duration_seconds: observedDuration }),
  };
}

function mergeIds(id: string): string[] {
  return id.split(",").filter((part) => part !== "");
}

/** Validates, sorts, and coalesces overlapping sponsor intervals. */
export function normalizeSponsorBlockIntervals(
  values: readonly unknown[],
  videoDurationSeconds?: number | null,
): SponsorBlockInterval[] {
  const duration = finiteNonNegative(videoDurationSeconds);
  const intervals = values.flatMap((value) => {
    const interval = rawInterval(value, duration);
    return interval === undefined ? [] : [interval];
  }).sort((left, right) => left.start_seconds - right.start_seconds || left.end_seconds - right.end_seconds || left.id.localeCompare(right.id));
  const coalesced: RawInterval[] = [];
  for (const interval of intervals) {
    const previous = coalesced.at(-1);
    if (previous === undefined || interval.start_seconds >= previous.end_seconds) {
      coalesced.push(interval);
      continue;
    }
    previous.end_seconds = Math.max(previous.end_seconds, interval.end_seconds);
    previous.id = [...mergeIds(previous.id), interval.id].join(",");
    if (previous.video_duration_seconds === undefined) previous.video_duration_seconds = interval.video_duration_seconds;
  }
  return coalesced.map((interval) => ({
    id: interval.id,
    category: "sponsor",
    action: "skip",
    start_seconds: interval.start_seconds,
    end_seconds: interval.end_seconds,
    ...(interval.video_duration_seconds === undefined ? {} : { video_duration_seconds: interval.video_duration_seconds }),
  }));
}

export const normalizeSponsorIntervals = normalizeSponsorBlockIntervals;

function intervalIds(intervals: readonly SponsorBlockInterval[]): string[] {
  return intervals.flatMap((interval) => mergeIds(interval.id));
}

function defaultFetch(url: string, init?: SponsorBlockFetchInit): Promise<SponsorBlockFetchResponse> {
  return fetch(url, init);
}

function abortError(): Error {
  const error = new Error("SponsorBlock lookup was cancelled");
  error.name = "AbortError";
  return error;
}

async function fetchWithTimeout(
  fetcher: SponsorBlockFetcher,
  url: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SponsorBlockFetchResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let rejectCancellation: ((reason: unknown) => void) | undefined;
  let timedOut = false;
  if (signal?.aborted) throw abortError();
  const onAbort = (): void => {
    controller.abort();
    rejectCancellation?.(abortError());
  };
  const cancellation = new Promise<never>((_, reject) => { rejectCancellation = reject; });
  signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("SponsorBlock request timed out"));
    }, timeoutMs);
  });
  try {
    const request = fetcher(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const response = await Promise.race(signal === undefined ? [request, timeout] : [request, timeout, cancellation]);
    if (signal?.aborted) throw abortError();
    return response;
  } catch (error) {
    if (signal?.aborted) throw abortError();
    if (timedOut) throw new Error("SponsorBlock request timed out");
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

function retryEligibleAt(publicationDate: string | null | undefined, lookedUpAt: Date): Date {
  const published = asDate(publicationDate);
  const age = published === undefined ? 0 : lookedUpAt.getTime() - published.getTime();
  const retryDays = age >= SPONSORBLOCK_YOUNG_VIDEO_DAYS * MILLISECONDS_PER_DAY
    ? SPONSORBLOCK_OLD_RETRY_DAYS
    : SPONSORBLOCK_YOUNG_RETRY_DAYS;
  return new Date(lookedUpAt.getTime() + retryDays * MILLISECONDS_PER_DAY);
}

export function sponsorBlockRetryEligibleAt(publicationDate: string | null | undefined, lookedUpAt: string | Date): string {
  const date = asDate(lookedUpAt);
  if (date === undefined) throw new TypeError("lookedUpAt must be a valid date");
  return retryEligibleAt(publicationDate, date).toISOString();
}

export function isSponsorBlockLookupReusable(
  lookup: SponsorBlockLookupProvenance | undefined,
  videoId: string,
  now: string | Date,
  expectedDurationSeconds?: number | null,
): boolean {
  if (lookup === undefined || lookup.state === "not_attempted" || lookup.video_id !== videoId) return false;
  if (lookup.state === "matched" && !areSponsorBlockDurationsCompatible(expectedDurationSeconds, lookup.video_duration_seconds)) return false;
  if (lookup.state === "matched") return true;
  if (lookup.state !== "empty") return false;
  const current = asDate(now);
  const retryAt = asDate(lookup.negative_cache.retry_eligible_at);
  return current !== undefined && retryAt !== undefined && current.getTime() < retryAt.getTime();
}

export const canReuseSponsorBlockLookup = isSponsorBlockLookupReusable;

function lookupBase(videoId: string, lookedUpAt: string, publicationDate: string | null | undefined, videoDurationSeconds: number | null | undefined) {
  return {
    source: SPONSORBLOCK_ATTRIBUTION,
    video_id: videoId,
    looked_up_at: lookedUpAt,
    ...(publicationDate === undefined ? {} : { publication_date: publicationDate }),
    ...(finiteNonNegative(videoDurationSeconds) === undefined ? {} : { video_duration_seconds: finiteNonNegative(videoDurationSeconds) }),
  };
}

function unavailableLookup(videoId: string, lookedUpAt: string, errorCode: string, options: SponsorBlockLookupOptions): SponsorBlockLookupProvenance {
  return { ...lookupBase(videoId, lookedUpAt, options.publicationDate, options.videoDurationSeconds), state: "unavailable", error_code: errorCode };
}

/** Performs one bounded lookup, or reuses a compatible stored snapshot. */
export async function lookupSponsorBlock(
  videoId: string,
  options: SponsorBlockLookupOptions = {},
): Promise<SponsorBlockLookupProvenance> {
  if (videoId.trim() === "") throw new TypeError("videoId must not be empty");
  const existing = options.existing ?? options.stored;
  const now = nowFrom(options);
  if (isSponsorBlockLookupReusable(existing, videoId, now, options.videoDurationSeconds)) return existing as SponsorBlockLookupProvenance;
  const lookedUpAt = now.toISOString();
  const timeoutMs = options.timeoutMs ?? SPONSORBLOCK_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("timeoutMs must be positive");
  try {
    const response = await fetchWithTimeout(options.fetcher ?? defaultFetch, sponsorBlockLookupUrl(videoId), timeoutMs, options.signal);
    if (response.status === 404) {
      const publicationDate = options.publicationDate ?? null;
      return {
        ...lookupBase(videoId, lookedUpAt, publicationDate, options.videoDurationSeconds),
        state: "empty",
        intervals: [],
        negative_cache: { publication_date: publicationDate, looked_up_at: lookedUpAt, retry_eligible_at: sponsorBlockRetryEligibleAt(publicationDate, now) },
      };
    }
    if (!response.ok) return unavailableLookup(videoId, lookedUpAt, `http_${response.status}`, options);
    const body = await response.json();
    if (!Array.isArray(body)) return unavailableLookup(videoId, lookedUpAt, "invalid_response", options);
    const exact = body.filter((item): boolean => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return record.videoID === videoId || record.video_id === videoId;
    });
    const candidates = exact.filter((item): boolean => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
      const record = item as Record<string, unknown>;
      return record.category === "sponsor" && (record.actionType === "skip" || record.action === "skip");
    });
    const intervals = normalizeSponsorBlockIntervals(candidates, options.videoDurationSeconds);
    if (candidates.length > 0 && intervals.length === 0) return unavailableLookup(videoId, lookedUpAt, "incompatible_or_invalid_intervals", options);
    if (intervals.length === 0) {
      const publicationDate = options.publicationDate ?? null;
      return {
        ...lookupBase(videoId, lookedUpAt, publicationDate, options.videoDurationSeconds),
        state: "empty",
        intervals: [],
        negative_cache: { publication_date: publicationDate, looked_up_at: lookedUpAt, retry_eligible_at: sponsorBlockRetryEligibleAt(publicationDate, now) },
      };
    }
    const responseDuration = candidates.flatMap((item) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
      const duration = finiteNonNegative((item as Record<string, unknown>).videoDuration ?? (item as Record<string, unknown>).video_duration_seconds);
      return duration === undefined ? [] : [duration];
    })[0];
    const videoDuration = finiteNonNegative(options.videoDurationSeconds) ?? responseDuration;
    return { ...lookupBase(videoId, lookedUpAt, options.publicationDate, videoDuration), state: "matched", intervals };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    return unavailableLookup(videoId, lookedUpAt, "request_failed", options);
  }
}

export class SponsorBlockService {
  private readonly options: Omit<SponsorBlockLookupOptions, "existing" | "stored" | "signal">;

  constructor(options: Omit<SponsorBlockLookupOptions, "existing" | "stored" | "signal"> = {}) {
    this.options = options;
  }

  lookup(videoId: string, options: Omit<SponsorBlockLookupOptions, "fetcher" | "now" | "clock" | "timeoutMs"> = {}): Promise<SponsorBlockLookupProvenance> {
    return lookupSponsorBlock(videoId, { ...this.options, ...options });
  }
}

function durationForFilter(options: SponsorBlockFilterOptions): number | undefined {
  return finiteNonNegative(options.videoDurationSeconds ?? options.durationSeconds);
}

function filterIntervals(lookup: Extract<SponsorBlockLookupProvenance, { state: "matched" }>, duration: number | undefined): SponsorBlockInterval[] | undefined {
  if (!areSponsorBlockDurationsCompatible(duration, lookup.video_duration_seconds)) return undefined;
  const referenceDuration = duration ?? finiteNonNegative(lookup.video_duration_seconds);
  if (lookup.intervals.some((interval) => rawInterval(interval, referenceDuration) === undefined)) return undefined;
  return normalizeSponsorBlockIntervals(lookup.intervals, referenceDuration);
}

/** Builds an analysis view while retaining the original transcript unchanged. */
export function filterTranscriptForAnalysis(
  original: OriginalTranscript,
  lookup: SponsorBlockLookupProvenance,
  options: SponsorBlockFilterOptions = {},
): SponsorBlockFilterResult {
  const allIds = original.segments.map((segment) => segment.segment_id);
  const duration = durationForFilter(options);
  let intervals: SponsorBlockInterval[] = [];
  let outcome: TranscriptFilteringProvenance["outcome"] = "unchanged";
  let reason: TranscriptFilteringProvenance["reason"] = "no_sponsor_matches";
  if (lookup.state === "not_attempted") {
    outcome = "not_attempted";
    reason = "not_attempted";
  } else if (lookup.state === "unavailable") {
    reason = "lookup_unavailable";
  } else if (lookup.state === "matched") {
    const compatible = filterIntervals(lookup, duration);
    if (compatible === undefined) {
      outcome = "incompatible_intervals";
      reason = "incompatible_intervals";
    } else if (compatible.length === 0) {
      intervals = compatible;
    } else if (original.timing !== "available") {
      outcome = "timing_unavailable";
      reason = "transcript_timing_unavailable";
      intervals = compatible;
    } else {
      intervals = compatible;
      const retained = original.segments.filter((segment) => {
        if (!("start_seconds" in segment) || !("duration_seconds" in segment)) return true;
        const start = segment.start_seconds;
        const end = start + segment.duration_seconds;
        return !intervals.some((interval) => start >= interval.start_seconds && end <= interval.end_seconds);
      });
      const retainedIds = retained.map((segment) => segment.segment_id);
      const excludedIds = allIds.filter((id) => !retainedIds.includes(id));
      if (excludedIds.length > 0) {
        outcome = "filtered";
        reason = "sponsor_intervals_applied";
        const analysis = createAnalysisTranscript(original, retainedIds);
        return {
          analysis,
          retained_segment_ids: retainedIds,
          filtering: {
            outcome,
            reason,
            lookup_state: lookup.state,
            timing: original.timing,
            boundary_policy: "exclude_wholly_contained_preserve_partial_overlap",
            original_segment_count: original.segments.length,
            retained_segment_count: retained.length,
            excluded_segment_count: excludedIds.length,
            excluded_segment_ids: excludedIds,
            interval_ids: intervalIds(intervals),
          },
        };
      }
    }
  } else if (lookup.state === "empty") {
    reason = "no_sponsor_matches";
  }
  const analysis = createAnalysisTranscript(original, allIds);
  return {
    analysis,
    retained_segment_ids: allIds,
    filtering: {
      outcome,
      reason,
      lookup_state: lookup.state,
      timing: original.timing,
      boundary_policy: "exclude_wholly_contained_preserve_partial_overlap",
      original_segment_count: original.segments.length,
      retained_segment_count: original.segments.length,
      excluded_segment_count: 0,
      excluded_segment_ids: [],
      interval_ids: intervalIds(intervals),
    },
  };
}

export const filterTranscript = filterTranscriptForAnalysis;
export const applySponsorBlockFilter = filterTranscriptForAnalysis;
