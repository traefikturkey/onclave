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
  const layout = calculateColumnWidths(rows, safeWidth);
  for (const peer of rows) {
    const status = formatPeerState(peer);
    const dot = renderStatusDot(peer, theme);
    const namePart = theme.fg("accent", padRight(abbreviate(peer.displayName, layout.nameWidth), layout.nameWidth));
    const modelPart = theme.fg("dim", padRight(abbreviate(peer.model ?? "unknown", layout.modelWidth), layout.modelWidth));
    const statePart = colorizeHex(peerStateHex(peer), `[${padRight(status, layout.stateWidth)}]`);
    const endpointPart = theme.fg("muted", abbreviate(shortEndpoint(peer.endpoint), layout.endpointWidth));
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

function calculateColumnWidths(peers: OnclavePeerWidgetPeer[], width: number): {
  nameWidth: number;
  modelWidth: number;
  stateWidth: number;
  endpointWidth: number;
} {
  const stateWidth = 14;
  const baseOverhead = 7; // leading space, dot, spaces, brackets
  const minNameWidth = 8;
  const maxNameWidth = 16;
  const minModelWidth = 10;
  const maxModelWidth = 24;
  const minEndpointWidth = 12;

  const desiredNameWidth = clamp(
    Math.max(...peers.map((peer) => peer.displayName.length), minNameWidth),
    minNameWidth,
    maxNameWidth
  );
  const desiredModelWidth = clamp(
    Math.max(...peers.map((peer) => (peer.model ?? "unknown").length), minModelWidth),
    minModelWidth,
    maxModelWidth
  );

  let nameWidth = desiredNameWidth;
  let modelWidth = desiredModelWidth;
  let endpointWidth = width - baseOverhead - nameWidth - modelWidth - stateWidth;

  if (endpointWidth < minEndpointWidth) {
    const deficit = minEndpointWidth - endpointWidth;
    const shrinkModel = Math.min(deficit, modelWidth - minModelWidth);
    modelWidth -= shrinkModel;
    endpointWidth += shrinkModel;
  }
  if (endpointWidth < minEndpointWidth) {
    const deficit = minEndpointWidth - endpointWidth;
    const shrinkName = Math.min(deficit, nameWidth - minNameWidth);
    nameWidth -= shrinkName;
    endpointWidth += shrinkName;
  }

  return {
    nameWidth,
    modelWidth,
    stateWidth,
    endpointWidth: Math.max(minEndpointWidth, endpointWidth),
  };
}

function renderTopBorder(width: number, input: OnclavePeerWidgetInput, theme: OnclavePeerWidgetTheme): string {
  if (width < 20) {
    return theme.fg("dim", "━".repeat(width));
  }

  const title = theme.fg("border", " onclave ");
  const left = theme.fg("dim", "┏━") + title;
  const rightLabel = input.localLabel
    ? theme.fg("dim", "━ ") + colorize(input.localColor, input.localLabel) + theme.fg("dim", " ━┓")
    : theme.fg("dim", "━┓");
  const fillerLength = Math.max(0, width - visibleTextLength(left) - visibleTextLength(rightLabel));
  return left + theme.fg("dim", "━".repeat(fillerLength)) + rightLabel;
}

function renderStatusDot(peer: OnclavePeerWidgetPeer, theme: OnclavePeerWidgetTheme): string {
  if (peer.authState === "authenticated") return colorizeHex("#22c55e", "●");
  if (peer.authState === "in_progress") return colorizeHex("#f59e0b", "◐");
  if (peer.authState === "failed" || peer.trustState === "auth_failed") return colorizeHex("#ef4444", "✗");
  if (peer.trustState === "trusted") return colorizeHex("#3b82f6", "●");
  if (peer.trustState === "stale") return theme.fg("dim", "~");
  return colorizeHex("#d946ef", "◆");
}

function peerStateHex(peer: OnclavePeerWidgetPeer): string {
  if (peer.authState === "authenticated") return "#22c55e";
  if (peer.authState === "in_progress") return "#f59e0b";
  if (peer.authState === "failed" || peer.trustState === "auth_failed") return "#ef4444";
  if (peer.trustState === "trusted") return "#3b82f6";
  if (peer.trustState === "stale") return "#6b7280";
  return "#d946ef";
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function colorize(color: string | undefined, text: string): string {
  return colorizeHex(color, text);
}

function colorizeHex(color: string | undefined, text: string): string {
  if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) return text;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function visibleTextLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}
