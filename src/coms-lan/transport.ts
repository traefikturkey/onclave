import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import {
  ReplayCache,
  verifyClientHandshake,
  type HandshakeFailureReason,
  type HandshakePayload,
} from "./handshake";
import type { LocalAgent } from "./local-registry";

export type ClientAuthFrame = {
  type: "client_auth";
  payload: HandshakePayload;
  publicKeyHex: string;
  signatureHex: string;
};

export type AuthenticatedPeer = {
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
  fingerprint: string;
  authenticatedAt: string;
};

export type SendPromptFrame = {
  type: "send_prompt";
  msgId: string;
  targetSessionId: string;
  prompt: string;
  hops: number;
};

export type ListAgentsFrame = {
  type: "list_agents";
};

export type HubFrame = ClientAuthFrame | ListAgentsFrame | SendPromptFrame;

export type SendPromptRouteResult =
  | { ok: true; msgId: string; status: "delivered" }
  | { ok: false; error: string };

export type HubFrameResponse =
  | { type: "auth_ok"; peer: AuthenticatedPeer }
  | { type: "auth_failed"; reason: HandshakeFailureReason }
  | { type: "agents"; agents: LocalAgent[] }
  | { type: "send_accepted"; msgId: string; status: "delivered" }
  | { type: "send_rejected"; msgId: string; error: string }
  | { type: "error"; code: "invalid_frame" | "auth_required" | "unsupported_frame" };

export type HubTransportAuthGateOptions = {
  authorizedKeys: AuthorizedSshEd25519Key[];
  now: () => Date;
  maxSkewMs: number;
};

export type HubFrameProcessorOptions = {
  gate: HubTransportAuthGate;
  listAgents: () => LocalAgent[];
  onSendPrompt: (frame: SendPromptFrame) => Promise<SendPromptRouteResult | void>;
};

export type TransportAuthResult =
  | { ok: true; peer: AuthenticatedPeer }
  | { ok: false; reason: HandshakeFailureReason };

export class HubFrameProcessor {
  private authenticatedNodeId: string | null = null;

  constructor(private readonly options: HubFrameProcessorOptions) {}

  async handleRaw(raw: string | Buffer): Promise<HubFrameResponse> {
    const frame = parseFrame(raw);
    if (!frame) return { type: "error", code: "invalid_frame" };

    switch (frame.type) {
      case "client_auth":
        return this.handleClientAuth(frame);
      case "list_agents":
        if (!this.isAuthenticated()) return { type: "error", code: "auth_required" };
        return { type: "agents", agents: this.options.listAgents() };
      case "send_prompt": {
        if (!this.isAuthenticated()) return { type: "error", code: "auth_required" };
        const result = await this.options.onSendPrompt(frame);
        if (result && !result.ok) {
          return { type: "send_rejected", msgId: frame.msgId, error: result.error };
        }
        return { type: "send_accepted", msgId: frame.msgId, status: "delivered" };
      }
      default:
        return { type: "error", code: "unsupported_frame" };
    }
  }

  private async handleClientAuth(frame: ClientAuthFrame): Promise<HubFrameResponse> {
    const result = await this.options.gate.authenticateClient(frame);
    if (!result.ok) return { type: "auth_failed", reason: result.reason };
    this.authenticatedNodeId = result.peer.nodeId;
    return { type: "auth_ok", peer: result.peer };
  }

  private isAuthenticated(): boolean {
    return this.authenticatedNodeId !== null && this.options.gate.canListAgents(this.authenticatedNodeId);
  }
}

export class HubTransportAuthGate {
  private readonly replayCache = new ReplayCache();
  private readonly authenticated = new Map<string, AuthenticatedPeer>();

  constructor(private readonly options: HubTransportAuthGateOptions) {}

  async authenticateClient(frame: ClientAuthFrame): Promise<TransportAuthResult> {
    const now = this.options.now();
    const result = await verifyClientHandshake({
      payload: frame.payload,
      signatureHex: frame.signatureHex,
      publicKeyHex: frame.publicKeyHex,
      authorizedKeys: this.options.authorizedKeys,
      replayCache: this.replayCache,
      now,
      maxSkewMs: this.options.maxSkewMs,
    });

    if (!result.ok) return result;

    const peer: AuthenticatedPeer = {
      nodeId: frame.payload.client_node_id,
      hubInstanceId: frame.payload.client_instance_id,
      endpoint: frame.payload.client_endpoint,
      fingerprint: result.fingerprint,
      authenticatedAt: now.toISOString(),
    };
    this.authenticated.set(peer.nodeId, peer);
    return { ok: true, peer };
  }

  canListAgents(nodeId: string): boolean {
    return this.authenticated.has(nodeId);
  }

  canSendMessages(nodeId: string): boolean {
    return this.authenticated.has(nodeId);
  }

  authenticatedPeers(): AuthenticatedPeer[] {
    return [...this.authenticated.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  }
}

function parseFrame(raw: string | Buffer): HubFrame | null {
  try {
    const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString("utf8") : raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    switch (record.type) {
      case "client_auth":
        return isClientAuthFrame(record) ? record : null;
      case "list_agents":
        return { type: "list_agents" };
      case "send_prompt":
        return isSendPromptFrame(record) ? record : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

function isClientAuthFrame(value: Record<string, unknown>): value is ClientAuthFrame {
  return (
    value.type === "client_auth" &&
    isHandshakePayload(value.payload) &&
    typeof value.publicKeyHex === "string" &&
    typeof value.signatureHex === "string"
  );
}

function isHandshakePayload(value: unknown): value is HandshakePayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.protocol === "coms-lan" &&
    record.version === 1 &&
    typeof record.client_node_id === "string" &&
    typeof record.server_node_id === "string" &&
    typeof record.client_instance_id === "string" &&
    typeof record.server_instance_id === "string" &&
    typeof record.client_endpoint === "string" &&
    typeof record.server_endpoint === "string" &&
    typeof record.client_nonce === "string" &&
    typeof record.server_nonce === "string" &&
    typeof record.timestamp === "string"
  );
}

function isSendPromptFrame(value: Record<string, unknown>): value is SendPromptFrame {
  return (
    value.type === "send_prompt" &&
    typeof value.msgId === "string" &&
    value.msgId.length > 0 &&
    typeof value.targetSessionId === "string" &&
    value.targetSessionId.length > 0 &&
    typeof value.prompt === "string" &&
    typeof value.hops === "number" &&
    Number.isInteger(value.hops) &&
    value.hops >= 0
  );
}
