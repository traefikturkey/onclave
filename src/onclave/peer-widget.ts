import { truncateToWidth } from "@earendil-works/pi-tui";
import type { DiscoveredPeer } from "./discovery";

export type OnclavePeerWidgetPeer = Pick<DiscoveredPeer, "nodeId" | "endpoint" | "trustState" | "authState"> & {
  displayName: string;
  model?: string;
};

export type OnclavePeerWidgetInput = {
  localLabel: string;
  localColor?: string;
  peers: OnclavePeerWidgetPeer[];
};

export type OnclavePeerWidgetTheme = {
  fg: (name: any, text: string) => string;
  bold: (text: string) => string;
};

export function renderOnclavePeerWidget(
  width: number,
  input: OnclavePeerWidgetInput,
  theme: OnclavePeerWidgetTheme
): string[] {
  const safeWidth = Math.max(12, width);
  const topBorder = renderTopBorder(safeWidth, input, theme);
  const bottomBorder = theme.fg("dim", "┗" + "━".repeat(Math.max(0, safeWidth - 2)) + "┛");

  if (input.peers.length === 0) {
    return [
      topBorder,
      truncateToWidth(" " + theme.fg("muted", "no peers discovered"), safeWidth),
      bottomBorder,
    ];
  }

  const out = [topBorder];
  const rows = [...input.peers].sort((left, right) => left.displayName.localeCompare(right.displayName));
  for (const peer of rows) {
    const status = formatPeerState(peer);
    const dot = renderStatusDot(peer, theme);
    const namePart = theme.fg("accent", padRight(peer.displayName, 12));
    const modelPart = theme.fg("dim", padRight(abbreviate(peer.model ?? "unknown", 14), 14));
    const statePart = theme.fg(peerStateColor(peer), `[${padRight(status, 14)}]`);
    const endpointPart = theme.fg("muted", abbreviate(shortEndpoint(peer.endpoint), Math.max(12, safeWidth - 39)));
    const line = ` ${dot} ${namePart} ${modelPart} ${statePart} ${endpointPart}`;
    out.push(truncateToWidth(line, safeWidth));
  }
  out.push(bottomBorder);
  return out;
}

export function formatPeerState(peer: Pick<OnclavePeerWidgetPeer, "trustState" | "authState">): string {
  if (peer.authState === "authenticated") return "trusted/auth";
  if (peer.authState === "in_progress") return "authing";
  if (peer.authState === "failed" || peer.trustState === "auth_failed") return "auth_failed";
  if (peer.trustState === "trusted") return "trusted/seen";
  if (peer.trustState === "stale") return "stale";
  return "untrusted/seen";
}

function renderTopBorder(width: number, input: OnclavePeerWidgetInput, theme: OnclavePeerWidgetTheme): string {
  if (width < 20) {
    return theme.fg("dim", "━".repeat(width));
  }

  const title = theme.fg("border", " onclave peers ");
  const left = theme.fg("dim", "┏━") + title;
  const rightLabel = input.localLabel
    ? theme.fg("dim", " ━") + colorize(input.localColor, input.localLabel) + theme.fg("dim", " ━┓")
    : theme.fg("dim", "━┓");
  const fillerLength = Math.max(0, width - visibleTextLength(left) - visibleTextLength(rightLabel));
  return left + theme.fg("dim", "━".repeat(fillerLength)) + rightLabel;
}

function renderStatusDot(peer: OnclavePeerWidgetPeer, theme: OnclavePeerWidgetTheme): string {
  if (peer.authState === "authenticated") return theme.fg("success", "●");
  if (peer.authState === "in_progress") return theme.fg("warning", "◐");
  if (peer.authState === "failed" || peer.trustState === "auth_failed") return theme.fg("error", "✗");
  if (peer.trustState === "trusted") return theme.fg("warning", "●");
  if (peer.trustState === "stale") return theme.fg("dim", "~");
  return theme.fg("dim", "○");
}

function peerStateColor(peer: OnclavePeerWidgetPeer): string {
  if (peer.authState === "authenticated") return "success";
  if (peer.authState === "in_progress") return "warning";
  if (peer.authState === "failed" || peer.trustState === "auth_failed") return "error";
  if (peer.trustState === "trusted") return "warning";
  return "muted";
}

function shortEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.hostname.replace(/^\[/, "").replace(/\]$/, "")}:${url.port}`;
  } catch {
    return endpoint;
  }
}

function abbreviate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function colorize(color: string | undefined, text: string): string {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return text;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function visibleTextLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
