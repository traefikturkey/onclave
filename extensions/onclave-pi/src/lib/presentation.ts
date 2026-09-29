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

const TERMINAL_SCHEMA = "onclave.job.terminal.v1";
const MAX_SUMMARY_LENGTH = 240;
const MAX_TITLE_LENGTH = 160;
const MAX_IDENTIFIER_LENGTH = 80;

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean === "") return undefined;
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength)}...`;
}

type StatusTheme = Pick<Theme, "fg" | "bold">;
const plainStatusTheme: StatusTheme = { fg: (_color, value) => value, bold: (value) => value };

function terminalSummary(body: string, theme: StatusTheme): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  const item = record(parsed);
  if (item?.schema !== TERMINAL_SCHEMA || item.version !== 1 || item.event !== "job_terminal") return undefined;

  const status = boundedText(item.status, MAX_IDENTIFIER_LENGTH);
  if (status === undefined) return undefined;
  const title = boundedText(item.title, MAX_TITLE_LENGTH);
  const summary = boundedText(item.summary, MAX_SUMMARY_LENGTH);
  const errorCode = boundedText(item.error_code, 80);
  const errorMessage = boundedText(item.error_message, MAX_SUMMARY_LENGTH);
  const errorStage = boundedText(item.error_stage, 48);
  const coverage = record(item.summary_coverage);
  const coverageStatus = coverage?.status === "full" || coverage?.status === "partial" || coverage?.status === "legacy" || coverage?.status === "unknown"
    ? coverage.status
    : undefined;
  const filtering = record(item.filtering);
  const filteringOutcome = filtering?.outcome === "filtered" || filtering?.outcome === "unchanged" || filtering?.outcome === "incompatible_intervals" || filtering?.outcome === "timing_unavailable" || filtering?.outcome === "not_attempted"
    ? filtering.outcome
    : undefined;
  const removed = typeof filtering?.excluded_segment_count === "number" && Number.isInteger(filtering.excluded_segment_count) && filtering.excluded_segment_count >= 0
    ? filtering.excluded_segment_count
    : undefined;
  const state = [
    coverageStatus === undefined ? undefined : `coverage ${coverageStatus}`,
    filtering?.lookup_state === "unavailable"
      ? "SponsorBlock unavailable"
      : filteringOutcome === undefined ? undefined : `filtering ${filteringOutcome}${removed === undefined ? "" : ` (${removed} removed)`}`,
  ].filter((value): value is string => value !== undefined);
  const heading = status === "failed"
    ? theme.fg("error", theme.bold("FAILED"))
    : status === "cancelled" || status === "canceled"
      ? theme.fg("warning", theme.bold("CANCELLED"))
      : status === "succeeded" || status === "success" || status === "completed"
        ? theme.fg("success", theme.bold("SUCCEEDED"))
        : `Job terminal: ${status}`;
  const reason = status === "failed"
    ? `${errorMessage === undefined ? "Failure reason not supplied" : errorMessage}${errorCode === undefined ? "" : ` [${errorCode}]`}${errorStage === undefined ? "" : ` (stage: ${errorStage})`}`
    : summary;
  const titleText = title === undefined ? undefined : boundedText(title, 100);
  // Identifiers remain available in the expanded raw envelope, but are not useful enough to
  // consume the small collapsed notification's limited width.
  const content = `${heading}${titleText === undefined ? "" : ` · ${titleText}`}${reason === undefined ? "" : ` · ${status === "failed" ? theme.fg("error", reason) : status === "cancelled" || status === "canceled" ? theme.fg("warning", reason) : reason}`}${state.length === 0 ? "" : ` · ${state.join(" · ")}`}`;
  return content;
}

/** Extract the peer-facing portion of the protocol-framed message for TUI-only display. */
export function inboundCollapsedText(message: InboundMessage, theme?: Theme): string {
  const content = typeof message.content === "string" ? message.content : "";
  const sender = content.match(/^Sender: (.+)$/m)?.[1] ?? "unknown sender";
  // Capture and reuse the complete marker: a mismatched end delimiter must not truncate peer input.
  const framed = content.match(/----- begin Onclave ([^\n]+) -----\n([\s\S]*?)\n----- end Onclave \1 -----/);
  const body = framed?.[2] ?? content;
  return `Onclave from ${sender}\n${terminalSummary(body, theme ?? plainStatusTheme) ?? body}`;
}

export function renderInboundMessage(message: InboundMessage, options: { expanded: boolean; outputPad?: number }, theme: Theme): Component {
  const content = options.expanded ? (typeof message.content === "string" ? message.content : "") : inboundCollapsedText(message, theme);
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
