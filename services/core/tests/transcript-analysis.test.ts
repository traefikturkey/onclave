import { describe, expect, it } from "vitest";
import {
  createAnalysisTranscript,
  normalizeOriginalTranscript,
  normalizeSponsorBlockLookup,
  normalizeStoredSummary,
  normalizeTranscriptAnalysisMetadata,
  serializeTranscript,
  toTimedTranscript,
  type TranscriptDownloadResponse,
  type WholeTranscriptResolver,
} from "../src/vault/transcript-analysis";

const filtering = {
  outcome: "unchanged" as const,
  reason: "no_sponsor_matches" as const,
  lookup_state: "empty" as const,
  timing: "available" as const,
  boundary_policy: "exclude_wholly_contained_preserve_partial_overlap" as const,
  original_segment_count: 2,
  retained_segment_count: 2,
  excluded_segment_count: 0,
  excluded_segment_ids: [],
  interval_ids: [],
};

const emptyLookup = {
  state: "empty" as const,
  video_id: "video-1",
  looked_up_at: "2026-09-21T10:00:00.000Z",
  publication_date: "2026-09-20T10:00:00.000Z",
  intervals: [] as [],
  negative_cache: {
    publication_date: "2026-09-20T10:00:00.000Z",
    looked_up_at: "2026-09-21T10:00:00.000Z",
    retry_eligible_at: "2026-09-22T10:00:00.000Z",
  },
};

const artifacts = {
  original: {
    variant: "original" as const,
    object_key: "content/video-1.txt",
    mime_type: "text/plain",
    byte_length: 20,
    sha256: "abc",
    created_at: "2026-09-21T10:00:00.000Z",
    source: "original_transcript" as const,
  },
  analysis: {
    variant: "analysis" as const,
    object_key: "content/video-1.analysis.txt",
    mime_type: "text/plain",
    byte_length: 12,
    sha256: "def",
    created_at: "2026-09-21T10:00:00.000Z",
    source: "analysis_transcript" as const,
  },
};

describe("transcript analysis contracts", () => {
  it("keeps old scalar-only records readable", () => {
    expect(normalizeStoredSummary({ summary: "Legacy summary" })).toEqual({ summary: "Legacy summary" });
    expect(normalizeStoredSummary({ summary: "", tags: ["old"] })).toEqual({ summary: "" });
  });

  it("normalizes the canonical summary and derives the legacy scalar", () => {
    expect(normalizeStoredSummary({
      summary: "independently authored and ignored",
      structured_summary: { version: "1", overview: " Overview ", key_points: [" first ", "second"] },
      outline: { version: 1, sections: [{ heading: " Start ", description: " The setup " }] },
      summary_coverage: {
        status: "full",
        source_variant: "analysis",
        generation_method: "single_call",
        source_segment_count: 2,
        source_range_count: 1,
        analyzed_segment_count: 2,
        analyzed_range_count: 1,
        analyzed_chunk_count: 1,
      },
    })).toEqual({
      summary: "Overview\n\n- first\n\n- second",
      structured_summary: { version: 1, overview: "Overview", key_points: ["first", "second"] },
      outline: { version: 1, sections: [{ heading: "Start", description: "The setup" }] },
      summary_coverage: {
        status: "full",
        source_variant: "analysis",
        generation_method: "single_call",
        source_segment_count: 2,
        source_range_count: 1,
        analyzed_segment_count: 2,
        analyzed_range_count: 1,
        analyzed_chunk_count: 1,
      },
    });
  });

  it("retains untimed supplied text without inventing timestamps", () => {
    const original = normalizeOriginalTranscript({
      text: "plain supplied transcript",
      segments: [{ text: "plain supplied transcript" }],
    });
    expect(original).toMatchObject({ representation: "original", timing: "unavailable" });
    expect(original?.segments).toEqual([{ segment_id: "segment-1", text: "plain supplied transcript" }]);
    expect(original === undefined ? undefined : toTimedTranscript(original)).toBeUndefined();
    if (original === undefined) throw new Error("original transcript was not normalized");
    const analysis = createAnalysisTranscript(original, ["segment-1"]);
    expect(analysis).toEqual({
      representation: "analysis",
      text: "plain supplied transcript",
      timing: "unavailable",
      source_variant: "untimed",
      segments: [{ source_segment_id: "segment-1", text: "plain supplied transcript" }],
    });
    expect(serializeTranscript(analysis)).toBe("plain supplied transcript");
  });

  it("preserves timed source segments and their original timestamps", () => {
    const original = normalizeOriginalTranscript({
      text: "opening body",
      segments: [
        { id: "a", text: "opening", start: 10, duration: 2 },
        { id: "b", text: "body", start: 12, duration: 3 },
      ],
    });
    expect(original?.timing).toBe("available");
    expect(original === undefined ? undefined : toTimedTranscript(original)).toEqual({
      representation: "timed",
      text: "opening body",
      segments: [
        { segment_id: "a", text: "opening", start_seconds: 10, duration_seconds: 2 },
        { segment_id: "b", text: "body", start_seconds: 12, duration_seconds: 3 },
      ],
      source_variant: "original",
    });
  });

  it("records an empty SponsorBlock lookup as a reusable negative cache", () => {
    expect(normalizeSponsorBlockLookup(emptyLookup)).toMatchObject({
      state: "empty",
      video_id: "video-1",
      intervals: [],
      negative_cache: {
        publication_date: "2026-09-20T10:00:00.000Z",
        looked_up_at: "2026-09-21T10:00:00.000Z",
        retry_eligible_at: "2026-09-22T10:00:00.000Z",
      },
      source: { service: "SponsorBlock", license: "CC BY-NC-SA 4.0" },
    });
  });

  it("normalizes stored current provenance separately from historical artifacts", () => {
    const metadata = normalizeTranscriptAnalysisMetadata({
      contract_version: "1",
      current_transcript: {
        source_kind: "youtube_captions",
        video_id: "video-1",
        language: "en",
        captured_at: "2026-09-21T10:00:00.000Z",
        timing: "available",
      },
      artifacts,
      sponsorblock: emptyLookup,
      filtering,
      historical_artifacts: [{ artifact: "embedding_index", state: "legacy", source_variant: "unknown", source_chunk_count: 3 }],
    });
    expect(metadata).toMatchObject({
      contract_version: 1,
      current_transcript: { source_kind: "youtube_captions", timing: "available" },
      artifacts,
      filtering,
      historical_artifacts: [{ artifact: "embedding_index", state: "legacy", source_variant: "unknown", source_chunk_count: 3 }],
    });
  });

  it("allows an all-excluded analysis representation to stay empty", () => {
    const original = normalizeOriginalTranscript({
      text: "sponsor one sponsor two",
      segments: [
        { id: "s1", text: "sponsor one", start: 0, duration: 2 },
        { id: "s2", text: "sponsor two", start: 2, duration: 2 },
      ],
    });
    if (original === undefined) throw new Error("original transcript was not normalized");
    const analysis = createAnalysisTranscript(original, []);
    expect(analysis.text).toBe("");
    expect(analysis.segments).toEqual([]);
    expect(serializeTranscript(analysis)).not.toContain("sponsor");
  });

  it("keeps download and resolver contracts explicit", async () => {
    const response: TranscriptDownloadResponse = {
      content_id: "content-1",
      variant: "analysis",
      artifact: artifacts.analysis,
      filtering: {
        outcome: "filtered",
        reason: "sponsor_intervals_applied",
        lookup_state: "matched",
        timing: "available",
        retained_segment_count: 1,
        excluded_segment_count: 1,
      },
    };
    const resolver: WholeTranscriptResolver = {
      async resolve(request) {
        expect(request).toEqual({ content_id: "content-1", variant: "analysis", access: "download" });
        const original = normalizeOriginalTranscript({ text: "retained", segments: [{ id: "a", text: "retained", start: 1, duration: 1 }] });
        if (original === undefined) throw new Error("original transcript was not normalized");
        return {
          content_id: request.content_id,
          variant: request.variant,
          transcript: createAnalysisTranscript(original, ["a"]),
          artifact: artifacts.analysis,
          current_transcript: { source_kind: "youtube_captions", timing: "available" },
          filtering: { ...filtering, outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", retained_segment_count: 1, excluded_segment_count: 0 },
        };
      },
    };
    expect(response.variant).toBe("analysis");
    const resolved = await resolver.resolve({ content_id: "content-1", variant: "analysis", access: "download" });
    expect(resolved.transcript.text).toBe("retained");
  });
});
