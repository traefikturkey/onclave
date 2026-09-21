import { describe, expect, it } from "vitest";
import { TranscriptArtifactResolver, storeTranscriptArtifacts, type TranscriptSponsorBlock } from "../src/vault/transcript-artifacts";
import { normalizeOriginalTranscript, type SponsorBlockLookupProvenance } from "../src/vault/transcript-analysis";
import type { ContentMetadata } from "../src/vault/models";

function timedOriginal() {
  const original = normalizeOriginalTranscript({
    text: "intro sponsor body",
    segments: [
      { id: "intro", text: "intro", start: 0, duration: 5 },
      { id: "sponsor", text: "sponsor", start: 5, duration: 5 },
      { id: "body", text: "body", start: 10, duration: 5 },
    ],
  });
  if (original === undefined) throw new Error("test transcript did not normalize");
  return original;
}

function content(metadata: ContentMetadata["metadata"] = {}): ContentMetadata {
  return {
    id: "content-1",
    content_type: "youtube",
    title: "Video",
    mime_type: "application/json",
    file_size: 1,
    file_path: "youtube/video/transcript.txt",
    metadata: { video_id: "video", duration_seconds: 15, ...metadata },
  };
}

function lookup(state: SponsorBlockLookupProvenance["state"]): SponsorBlockLookupProvenance {
  const source = { service: "SponsorBlock" as const, source_url: "https://sponsor.ajay.app/" as const, license: "CC BY-NC-SA 4.0" as const };
  if (state === "matched") return { source, state, video_id: "video", looked_up_at: "2026-09-21T00:00:00.000Z", intervals: [{ id: "sponsor", category: "sponsor", action: "skip", start_seconds: 5, end_seconds: 10 }] };
  if (state === "empty") return { source, state, video_id: "video", looked_up_at: "2026-09-21T00:00:00.000Z", intervals: [], negative_cache: { publication_date: null, looked_up_at: "2026-09-21T00:00:00.000Z", retry_eligible_at: "2026-09-22T00:00:00.000Z" } };
  if (state === "unavailable") return { source, state, video_id: "video", looked_up_at: "2026-09-21T00:00:00.000Z", error_code: "request_failed" };
  return { state: "not_attempted" };
}

describe("transcript artifact resolver", () => {
  it("stores timed original data, materializes filtered analysis, and reuses the approved cache", async () => {
    const objects = new Map<string, Buffer>();
    const contents = new Map<string, ContentMetadata>();
    let lookups = 0;
    const original = timedOriginal();
    const storedArtifacts = await storeTranscriptArtifacts({
      async upload(key, stream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); objects.set(key, bytes); return bytes.length; },
      async download(key) { const bytes = objects.get(key); if (bytes === undefined) throw new Error(`missing ${key}`); return bytes; },
    }, "youtube/video/transcript.txt", original);
    const originalArtifact = storedArtifacts.original;
    contents.set("content-1", content({ transcript_analysis: {
      contract_version: 1,
      current_transcript: { source_kind: "youtube_captions", video_id: "video", timing: "available" },
      artifacts: { original: originalArtifact, ...(storedArtifacts.timed === undefined ? {} : { timed: storedArtifacts.timed }) },
      filtering: { outcome: "not_attempted", reason: "not_attempted", lookup_state: "not_attempted", timing: "available", boundary_policy: "exclude_wholly_contained_preserve_partial_overlap", original_segment_count: 3, retained_segment_count: 3, excluded_segment_count: 0, excluded_segment_ids: [], interval_ids: [] },
    } }));
    const repository = {
      async get_content(id: string) { return contents.get(id); },
      async update_content(id: string, value: ContentMetadata) { contents.set(id, value); return value; },
    };
    const resolver = new TranscriptArtifactResolver({
      storage: {
        async upload(key, stream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); objects.set(key, bytes); return bytes.length; },
        async download(key) { const bytes = objects.get(key); if (bytes === undefined) throw new Error(`missing ${key}`); return bytes; },
      },
      repository,
      sponsorblock: { async lookup() { lookups += 1; return lookup("matched"); } } satisfies TranscriptSponsorBlock,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });

    const first = await resolver.resolve({ content_id: "content-1", variant: "analysis", access: "download" });
    expect(first.transcript.text).toBe("intro body");
    expect(first.filtering).toMatchObject({ outcome: "filtered", excluded_segment_ids: ["sponsor"] });
    expect(objects.has("youtube/video/transcript.timed.json")).toBe(true);
    expect(objects.has("youtube/video/transcript.analysis.json")).toBe(true);
    expect(lookups).toBe(1);
    const second = await resolver.resolve({ content_id: "content-1", variant: "analysis", access: "download" });
    expect(second.transcript.text).toBe("intro body");
    expect(lookups).toBe(1);
  });

  it("prepares a legacy plain object lazily without inventing timing or invoking analysis side effects", async () => {
    const objects = new Map([["youtube/old/transcript.txt", Buffer.from("plain legacy transcript")]]);
    const contentRecord = content({ video_id: "old", resource_key: "yt:old" });
    contentRecord.id = "old-content";
    contentRecord.file_path = "youtube/old/transcript.txt";
    let updates = 0;
    let uploads = 0;
    const resolver = new TranscriptArtifactResolver({
      storage: {
        async upload(key, stream) { uploads += 1; const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); objects.set(key, bytes); return bytes.length; },
        async download(key) { const bytes = objects.get(key); if (bytes === undefined) throw new Error(`missing ${key}`); return bytes; },
      },
      repository: {
        async get_content() { return contentRecord; },
        async update_content(_id, value) { updates += 1; Object.assign(contentRecord, value); return value; },
      },
      sponsorblock: { async lookup() { throw new Error("untimed content must not look up SponsorBlock"); } } satisfies TranscriptSponsorBlock,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });

    const original = await resolver.resolve({ content_id: "old-content", variant: "original", access: "download" });
    expect(original.transcript.timing).toBe("unavailable");
    expect(original.transcript.text).toBe("plain legacy transcript");
    expect(original.current_transcript).toMatchObject({ source_kind: "legacy_stored", video_id: "old" });
    expect(uploads).toBe(0);
    const analysis = await resolver.resolve({ content_id: "old-content", variant: "analysis", access: "download" });
    expect(analysis.transcript.text).toBe("plain legacy transcript");
    expect(analysis.filtering).toMatchObject({ outcome: "not_attempted", reason: "not_attempted", timing: "unavailable" });
    expect(uploads).toBe(1);
    expect(updates).toBeGreaterThan(0);
  });

  it("refreshes an expired negative cache only during a whole-transcript analysis access", async () => {
    const objects = new Map<string, Buffer>();
    const original = timedOriginal();
    const storedArtifacts = await storeTranscriptArtifacts({
      async upload(key, stream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); objects.set(key, bytes); return bytes.length; },
      async download(key) { const bytes = objects.get(key); if (bytes === undefined) throw new Error(`missing ${key}`); return bytes; },
    }, "youtube/video/transcript.txt", original);
    const originalArtifact = storedArtifacts.original;
    const existing = lookup("empty");
    if (existing.state !== "empty") throw new Error("test lookup did not normalize");
    existing.negative_cache.retry_eligible_at = "2026-09-20T00:00:00.000Z";
    let current: ContentMetadata = content({ transcript_analysis: {
      contract_version: 1,
      current_transcript: { source_kind: "youtube_captions", video_id: "video", timing: "available" },
      artifacts: { original: originalArtifact, ...(storedArtifacts.timed === undefined ? {} : { timed: storedArtifacts.timed }) },
      sponsorblock: existing,
      filtering: { outcome: "unchanged", reason: "no_sponsor_matches", lookup_state: "empty", timing: "available", boundary_policy: "exclude_wholly_contained_preserve_partial_overlap", original_segment_count: 3, retained_segment_count: 3, excluded_segment_count: 0, excluded_segment_ids: [], interval_ids: [] },
    } });
    let lookups = 0;
    const resolver = new TranscriptArtifactResolver({
      storage: { async upload(key, stream) { const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); const bytes = Buffer.concat(chunks); objects.set(key, bytes); return bytes.length; }, async download(key) { const bytes = objects.get(key); if (bytes === undefined) throw new Error(`missing ${key}`); return bytes; } },
      repository: { async get_content() { return current; }, async update_content(_id, value) { current = value; return value; } },
      sponsorblock: { async lookup() { lookups += 1; return lookup("empty"); } } satisfies TranscriptSponsorBlock,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });
    await resolver.resolve({ content_id: "content-1", variant: "original", access: "download" });
    expect(lookups).toBe(0);
    await resolver.resolve({ content_id: "content-1", variant: "analysis", access: "download" });
    expect(lookups).toBe(1);
  });
});
