import { describe, expect, it } from "vitest";
import { projectVaultContent } from "../src/lib/vault-projection";

describe("vault content projection", () => {
  const content = {
    id: "c1", content_type: "youtube", title: "Title", processing_status: "completed", summary: "Summary",
    summary_coverage: { status: "full", generation_method: "single_call" },
    filtering: { outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", timing: "available", retained_segment_count: 2, excluded_segment_count: 1 },
    outline: { version: 1, sections: [{ heading: "Intro", description: "The setup." }] },
    tags: ["saved"], pipeline_tags: ["technical"], topics: ["topic"], entities: ["entity"],
    description: "Description", file_path: "private/object", metadata: {
      resource_key: "https://youtube.example/watch?v=v1", video_id: "v1", channel_id: "channel-1",
      channel_title: "Channel", published_at: "2026-01-01T00:00:00Z", duration_seconds: 42,
      source: { channel: "c1" }, ignored: "secret",
    },
  };

  it("uses a compact default with truthful coverage/filtering and useful metadata", () => {
    expect(projectVaultContent(content)).toEqual({
      id: "c1", content_type: "youtube", title: "Title", processing_status: "completed", summary: "Summary",
      summary_coverage: { status: "full", generation_method: "single_call" },
      filtering: { outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", timing: "available", retained_segment_count: 2, excluded_segment_count: 1 },
      tags: ["saved"], pipeline_tags: ["technical"], topics: ["topic"], entities: ["entity"],
      metadata: {
        resource_key: "https://youtube.example/watch?v=v1", video_id: "v1", channel_id: "channel-1",
        channel_title: "Channel", published_at: "2026-01-01T00:00:00Z", duration_seconds: 42,
      },
    });
  });

  it("projects supported fields and dotted metadata paths in canonical request order", () => {
    expect(projectVaultContent(content, { fields: ["metadata.source.channel", "outline", "summary_coverage", "title", "id"] })).toEqual({
      id: "c1", title: "Title", outline: { version: 1, sections: [{ heading: "Intro", description: "The setup." }] },
      summary_coverage: { status: "full", generation_method: "single_call" }, metadata: { source: { channel: "c1" } },
    });
    expect(projectVaultContent(content, { fields: "title" })).toEqual({ title: "Title" });
  });

  it("sorts unsupported fields in its deterministic error", () => {
    expect(() => projectVaultContent(content, { fields: ["z", "a"] })).toThrow("unsupported fields: a, z");
  });

  it("supports full view and rejects full with fields", () => {
    expect(projectVaultContent(content, { full: true })).toEqual({
      content_type: "youtube", description: "Description", entities: ["entity"], filtering: content.filtering,
      id: "c1", metadata: content.metadata, outline: content.outline,
      pipeline_tags: ["technical"], processing_status: "completed", summary: "Summary",
      summary_coverage: content.summary_coverage, tags: ["saved"], title: "Title", topics: ["topic"],
    });
    expect(() => projectVaultContent(content, { full: true, fields: "title" })).toThrow("fields and full cannot be used together");
  });
});
