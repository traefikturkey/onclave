import { Box, Text, type Component } from "@earendil-works/pi-tui";
import type { MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";

export const INBOUND_CUSTOM_TYPE = "onclave-inbound";
export const VAULT_CONTENT_TOOL = "onclave_vault_content";

type InboundMessage = { content: unknown; details?: unknown };
type ToolResult = { content?: Array<{ type?: string; text?: string }>; details?: unknown };

type InboundDetails = { messageId?: unknown; channelId?: unknown; sequence?: unknown };

function textComponent(text: string, theme: Theme, outputPad = 0): Component {
  const box = new Box(outputPad, 1, (value) => theme.bg("customMessageBg", value));
  box.addChild(new Text(text, 0, 0));
  return box;
}

/** Extract the peer-facing portion of the protocol-framed message for TUI-only display. */
export function inboundCollapsedText(message: InboundMessage): string {
  const content = typeof message.content === "string" ? message.content : "";
  const sender = content.match(/^Sender: (.+)$/m)?.[1] ?? "unknown sender";
  const body = content.match(/----- begin Onclave [^\n]+ -----\n([\s\S]*?)\n----- end Onclave [^\n]+ -----/)?.[1] ?? content;
  return `Onclave from ${sender}\n${body}`;
}

export function renderInboundMessage(message: InboundMessage, options: { expanded: boolean; outputPad?: number }, theme: Theme): Component {
  const content = options.expanded ? (typeof message.content === "string" ? message.content : "") : inboundCollapsedText(message);
  return textComponent(content, theme, options.outputPad ?? 0);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function displayValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Keep vault output model-visible and lossless while making the collapsed TUI useful. */
export function vaultCollapsedText(details: unknown): string {
  const item = record(details);
  const title = displayValue(item?.title) ?? "untitled";
  const type = displayValue(item?.content_type) ?? displayValue(item?.type) ?? "unknown type";
  const id = displayValue(item?.content_id) ?? displayValue(item?.id) ?? "unknown id";
  return `Vault content: ${title} · ${type} · ${id}`;
}

export function renderVaultResult(result: ToolResult, options: { expanded: boolean }, theme: Theme): Component {
  const contentText = result.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") ?? "";
  const text = options.expanded ? contentText : vaultCollapsedText(result.details);
  return new Text(text, 0, 0);
}

export const inboundMessageRenderer: MessageRenderer = (message, options, theme) => renderInboundMessage(message, options, theme);

export function registerPresentation(pi: {
  registerMessageRenderer: (customType: string, renderer: MessageRenderer) => void;
}): void {
  pi.registerMessageRenderer(INBOUND_CUSTOM_TYPE, inboundMessageRenderer);
}
