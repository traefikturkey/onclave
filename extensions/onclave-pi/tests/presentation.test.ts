import { describe, expect, it } from "vitest";
import { renderInboundMessage, renderVaultResult, inboundCollapsedText, vaultCollapsedText } from "../src/lib/presentation";

const theme = {
  bg: (_name: string, value: string) => value,
} as never;

function rendered(component: { render: (width: number) => string[] }, width = 120): string {
  return component.render(width).map((line) => line.trimEnd()).join("\n").trim();
}

describe("Onclave TUI presentation", () => {
  const framed = "Onclave inbound notification from an independent service.\nSender: Alice [pi-a] on host host-a\nChannel: c\nMessage id: m\n----- begin Onclave notification content marker -----\nhello from Alice\n----- end Onclave notification content marker -----";

  it("collapses inbound protocol framing to sender and body", () => {
    const collapsed = inboundCollapsedText({ content: framed, details: { messageId: "m" } });
    expect(collapsed).toBe("Onclave from Alice [pi-a] on host host-a\nhello from Alice");
    expect(collapsed).not.toContain("Channel:");
    expect(rendered(renderInboundMessage({ content: framed }, { expanded: false }, theme))).toContain("hello from Alice");
  });

  it("summarizes terminal envelopes when collapsed but preserves the raw envelope when expanded", () => {
    const envelope = JSON.stringify({
      schema: "onclave.job.terminal.v1",
      version: 1,
      event: "job_terminal",
      job_id: "job-1234567890",
      content_id: "content-abcdef",
      status: "failed",
      title: "A video about OCR",
      started_at: "2026-01-02T03:04:05.000Z",
      finished_at: "2026-01-02T03:05:06.000Z",
      duration_seconds: 61,
      summary: "OCR completed for the uploaded document; the final indexing stage failed.",
      summary_coverage: { status: "full", generation_method: "single_call" },
      filtering: { outcome: "filtered", reason: "sponsor_intervals_applied", lookup_state: "matched", timing: "available", retained_segment_count: 8, excluded_segment_count: 2 },
      trust: "untrusted_data",
      output: "a large terminal payload that should not be dumped into the collapsed view",
    });
    const content = framed.replace("hello from Alice", envelope);
    const collapsed = inboundCollapsedText({ content });
    expect(collapsed).toContain("Job terminal: failed · A video about OCR · job job-1234567890 · content content-abcdef");
    expect(collapsed).toContain("coverage full · filtering filtered (2 removed)");
    expect(collapsed).toContain("OCR completed for the uploaded document");
    expect(collapsed).not.toContain("onclave.job.terminal.v1");
    expect(collapsed).not.toContain("2026-01-02T03:04:05.000Z");
    expect(collapsed).not.toContain("large terminal payload");

    const expanded = rendered(renderInboundMessage({ content }, { expanded: true }, theme), 1000);
    expect(expanded).toBe(content);
    expect(expanded).toContain(envelope);
  });

  it("leaves malformed and non-terminal bodies unchanged", () => {
    const malformed = framed.replace("hello from Alice", "{not json}");
    expect(inboundCollapsedText({ content: malformed })).toContain("{not json}");
    const unknown = framed.replace("hello from Alice", JSON.stringify({ schema: "other.v1", timestamp: "2026-01-02T03:04:05.000Z" }));
    expect(inboundCollapsedText({ content: unknown })).toContain('"schema":"other.v1"');
  });

  it("requires the matching framing marker before extracting a body", () => {
    const mismatched = framed.replace("end Onclave notification content marker", "end Onclave different marker");
    expect(inboundCollapsedText({ content: mismatched })).toContain("hello from Alice");
    expect(inboundCollapsedText({ content: mismatched })).toContain("----- end Onclave different marker -----");
  });

  it("keeps the original inbound framing when expanded", () => {
    const expanded = rendered(renderInboundMessage({ content: framed }, { expanded: true }, theme));
    expect(expanded).toContain("Onclave inbound notification from an independent service.");
    expect(expanded).toContain("----- begin Onclave notification content marker -----");
    expect(expanded).toContain("hello from Alice");
  });

  it("summarizes vault title, type, and content id when collapsed", () => {
    expect(vaultCollapsedText({ title: "A paper", content_type: "pdf", id: "content-7" }))
      .toBe("Vault content: A paper · pdf · content-7");
    expect(vaultCollapsedText({ title: "A paper", content_type: "pdf", id: "content-7" })).not.toContain("raw");
    expect(rendered(renderVaultResult({ content: [{ type: "text", text: '{"secret":"raw"}' }], details: { title: "A paper", content_type: "pdf", id: "content-7" } }, { expanded: false }, theme)))
      .toContain("A paper · pdf · content-7");
  });

  it("preserves original vault output when expanded", () => {
    const raw = '{"title":"A paper","content":"full"}';
    expect(rendered(renderVaultResult({ content: [{ type: "text", text: raw }], details: { title: "A paper", content_type: "pdf", id: "content-7" } }, { expanded: true }, theme))).toBe(raw);
  });
});
