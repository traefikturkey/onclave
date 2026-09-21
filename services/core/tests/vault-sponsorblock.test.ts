import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeOriginalTranscript, type SponsorBlockLookupProvenance } from "../src/vault/transcript-analysis";
import {
  SPONSORBLOCK_OLD_RETRY_DAYS,
  SPONSORBLOCK_YOUNG_RETRY_DAYS,
  filterTranscriptForAnalysis,
  isSponsorBlockLookupReusable,
  lookupSponsorBlock,
  normalizeSponsorBlockIntervals,
  sponsorBlockHashPrefix,
  sponsorBlockLookupUrl,
  sponsorBlockRetryEligibleAt,
} from "../src/vault/sponsorblock";

const videoId = "dQw4w9WgXcQ";
const now = "2026-09-21T10:00:00.000Z";

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function transcript() {
  const original = normalizeOriginalTranscript({
    text: "intro sponsor body overlap",
    segments: [
      { id: "intro", text: "intro", start: 0, duration: 10 },
      { id: "sponsor", text: "sponsor", start: 10, duration: 10 },
      { id: "overlap", text: "overlap", start: 19, duration: 4 },
      { id: "body", text: "body", start: 24, duration: 6 },
    ],
  });
  if (original === undefined) throw new Error("test transcript did not normalize");
  return original;
}

describe("SponsorBlock", () => {
  it("uses the SHA-256 hash prefix and selects only exact sponsor/skip records", async () => {
    const calls: Array<{ url: string; signal?: AbortSignal }> = [];
    const lookup = await lookupSponsorBlock(videoId, {
      now: () => new Date(now),
      fetcher: async (url, init) => {
        calls.push({ url, signal: init?.signal });
        return response([
          { videoID: "another-video", UUID: "wrong", category: "sponsor", actionType: "skip", segment: [1, 2] },
          { videoID: videoId, UUID: "keep", category: "intro", actionType: "skip", segment: [2, 3] },
          { videoID: videoId, UUID: "keep", category: "sponsor", actionType: "mute", segment: [2, 3] },
          { videoID: videoId, UUID: "keep", category: "sponsor", actionType: "skip", segment: [10, 20], videoDuration: 30 },
        ]);
      },
      videoDurationSeconds: 30,
    });
    expect(calls[0]?.url).toBe(sponsorBlockLookupUrl(videoId));
    expect(calls[0]?.url).toContain(sponsorBlockHashPrefix(videoId));
    expect(lookup).toMatchObject({ state: "matched", video_id: videoId, intervals: [{ id: "keep", start_seconds: 10, end_seconds: 20 }] });
    expect(createHash("sha256").update(videoId).digest("hex").slice(0, 4)).toBe(sponsorBlockHashPrefix(videoId));
  });

  it("validates and coalesces overlapping intervals while preserving their IDs", () => {
    expect(normalizeSponsorBlockIntervals([
      { UUID: "a", category: "sponsor", actionType: "skip", segment: [10, 20] },
      { UUID: "b", category: "sponsor", actionType: "skip", segment: [18, 30] },
      { UUID: "bad", category: "sponsor", actionType: "skip", segment: [30, 30] },
      { UUID: "other", category: "intro", actionType: "skip", segment: [1, 2] },
    ])).toEqual([{
      id: "a,b",
      category: "sponsor",
      action: "skip",
      start_seconds: 10,
      end_seconds: 30,
    }]);
  });

  it("removes only wholly contained caption segments and preserves the original", () => {
    const original = transcript();
    const lookup: SponsorBlockLookupProvenance = {
      source: { service: "SponsorBlock", source_url: "https://sponsor.ajay.app/", license: "CC BY-NC-SA 4.0" },
      state: "matched",
      video_id: videoId,
      looked_up_at: now,
      intervals: [{ id: "sponsor", category: "sponsor", action: "skip", start_seconds: 10, end_seconds: 20 }],
    };
    const result = filterTranscriptForAnalysis(original, lookup);
    expect(result.analysis.text).toBe("intro overlap body");
    expect(result.filtering).toMatchObject({ outcome: "filtered", excluded_segment_ids: ["sponsor"], interval_ids: ["sponsor"] });
    expect(original.text).toBe("intro sponsor body overlap");
    expect(original.segments).toHaveLength(4);
  });

  it("keeps an all-excluded analysis empty without restoring the original", () => {
    const original = normalizeOriginalTranscript({
      text: "sponsor one sponsor two",
      segments: [{ id: "one", text: "sponsor one", start: 0, duration: 2 }, { id: "two", text: "sponsor two", start: 2, duration: 2 }],
    });
    if (original === undefined) throw new Error("test transcript did not normalize");
    const lookup: SponsorBlockLookupProvenance = {
      source: { service: "SponsorBlock", source_url: "https://sponsor.ajay.app/", license: "CC BY-NC-SA 4.0" },
      state: "matched", video_id: videoId, looked_up_at: now,
      intervals: [{ id: "all", category: "sponsor", action: "skip", start_seconds: 0, end_seconds: 4 }],
    };
    const result = filterTranscriptForAnalysis(original, lookup);
    expect(result.analysis.text).toBe("");
    expect(result.analysis.segments).toEqual([]);
    expect(original.text).toBe("sponsor one sponsor two");
  });

  it("reports missing timing and incompatible duration without removing text", () => {
    const untimed = normalizeOriginalTranscript({ text: "sponsor text", segments: [{ text: "sponsor text" }] });
    if (untimed === undefined) throw new Error("test transcript did not normalize");
    const lookup: SponsorBlockLookupProvenance = {
      source: { service: "SponsorBlock", source_url: "https://sponsor.ajay.app/", license: "CC BY-NC-SA 4.0" },
      state: "matched", video_id: videoId, looked_up_at: now, video_duration_seconds: 100,
      intervals: [{ id: "s", category: "sponsor", action: "skip", start_seconds: 0, end_seconds: 10, video_duration_seconds: 100 }],
    };
    expect(filterTranscriptForAnalysis(untimed, lookup).filtering.outcome).toBe("timing_unavailable");
    expect(filterTranscriptForAnalysis(transcript(), lookup, { videoDurationSeconds: 200 }).filtering.outcome).toBe("incompatible_intervals");
  });

  it("uses 24 hours for young or unknown videos and 30 days for old videos", () => {
    const young = sponsorBlockRetryEligibleAt("2026-09-20T10:00:00.000Z", now);
    const unknown = sponsorBlockRetryEligibleAt(null, now);
    const old = sponsorBlockRetryEligibleAt("2026-09-01T10:00:00.000Z", now);
    expect(Date.parse(young) - Date.parse(now)).toBe(SPONSORBLOCK_YOUNG_RETRY_DAYS * 86400000);
    expect(Date.parse(unknown) - Date.parse(now)).toBe(86400000);
    expect(Date.parse(old) - Date.parse(now)).toBe(SPONSORBLOCK_OLD_RETRY_DAYS * 86400000);
  });

  it("reuses positive and unexpired empty results, but refreshes at the exact expiry", () => {
    const positive: SponsorBlockLookupProvenance = {
      source: { service: "SponsorBlock", source_url: "https://sponsor.ajay.app/", license: "CC BY-NC-SA 4.0" },
      state: "matched", video_id: videoId, looked_up_at: now, intervals: [],
    };
    expect(isSponsorBlockLookupReusable(positive, videoId, now)).toBe(true);
    const empty: SponsorBlockLookupProvenance = {
      source: positive.source, state: "empty", video_id: videoId, looked_up_at: now, intervals: [],
      negative_cache: { publication_date: null, looked_up_at: now, retry_eligible_at: "2026-09-22T10:00:00.000Z" },
    };
    expect(isSponsorBlockLookupReusable(empty, videoId, "2026-09-22T09:59:59.999Z")).toBe(true);
    expect(isSponsorBlockLookupReusable(empty, videoId, "2026-09-22T10:00:00.000Z")).toBe(false);
  });

  it("treats a 404 as a negative result and a failure as unavailable", async () => {
    const empty = await lookupSponsorBlock(videoId, { now: () => new Date(now), fetcher: async () => response(undefined, 404) });
    expect(empty).toMatchObject({ state: "empty", intervals: [], negative_cache: { retry_eligible_at: "2026-09-22T10:00:00.000Z" } });
    const unavailable = await lookupSponsorBlock(videoId, { now: () => new Date(now), fetcher: async () => { throw new Error("offline"); } });
    expect(unavailable).toMatchObject({ state: "unavailable", error_code: "request_failed" });
  });

  it("bounds a non-cooperative fetch and propagates caller cancellation", async () => {
    const timedOut = await lookupSponsorBlock(videoId, {
      now: () => new Date(now),
      timeoutMs: 5,
      fetcher: async () => new Promise<never>(() => {}),
    });
    expect(timedOut).toMatchObject({ state: "unavailable", error_code: "request_failed" });

    const controller = new AbortController();
    const pending = lookupSponsorBlock(videoId, {
      now: () => new Date(now),
      signal: controller.signal,
      fetcher: async () => new Promise<never>(() => {}),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});
