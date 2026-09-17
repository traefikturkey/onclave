import { describe, expect, it } from "vitest";
import { renderInboundMessage, renderVaultResult, inboundCollapsedText, vaultCollapsedText } from "../src/lib/presentation";

const theme = {
  bg: (_name: string, value: string) => value,
} as never;

function rendered(component: { render: (width: number) => string[] }): string {
  return component.render(120).join("\n").trim();
}

describe("Onclave TUI presentation", () => {
  const framed = "Onclave inbound notification from an independent service.\nSender: Alice [pi-a] on host host-a\nChannel: c\nMessage id: m\n----- begin Onclave notification content marker -----\nhello from Alice\n----- end Onclave notification content marker -----";

  it("collapses inbound protocol framing to sender and body", () => {
    const collapsed = inboundCollapsedText({ content: framed, details: { messageId: "m" } });
    expect(collapsed).toBe("Onclave from Alice [pi-a] on host host-a\nhello from Alice");
    expect(collapsed).not.toContain("Channel:");
    expect(rendered(renderInboundMessage({ content: framed }, { expanded: false }, theme))).toContain("hello from Alice");
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
