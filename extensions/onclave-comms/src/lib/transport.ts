import { randomBytes } from "node:crypto";
import type { AuditEventName, AuditMetadata } from "./audit";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import {
  ReplayCache,
  signHandshakePayload,
  verifyClientHandshake,
  type HandshakeFailureReason,
  type HandshakePayload,
  type ServerHelloFrame,
  type ServerHelloPayload,
} from "./handshake";
import type { LocalAgent, LocalAgentRegistration } from "./local-registry";
import type { MessageResponse, SubmitResponseResult } from "./messages";
import {
  isPromptOriginMetadata,
  isPromptReplyMode,
  type PromptOriginMetadata,
  type PromptReplyMode,
} from "./prompt-metadata";

const MAX_FRAME_PROMPT_LENGTH = 100_000;

export type ClientAuthFrame = {
  type: "client_auth";
  payload: HandshakePayload;
  publicKeyHex: string;
  signatureHex: string;
};

export type AuthHelloFrame = {
  type: "auth_hello";
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
  replyMode?: PromptReplyMode;
  origin?: PromptOriginMetadata;
};

export type ListAgentsFrame = {
  type: "list_agents";
};

export type GetResponseFrame = {
  type: "get_response";
  msgId: string;
};

export type LocalRegisterFrame = {
  type: "local_register";
  registration: LocalAgentRegistration;
  localAuthToken?: string;
};

export type LocalUnregisterFrame = {
  type: "local_unregister";
  sessionId: string;
  localAuthToken?: string;
};

export type LocalSendPromptFrame = Omit<SendPromptFrame, "type"> & {
  type: "local_send_prompt";
  localAuthToken?: string;
};

export type LocalGetResponseFrame = Omit<GetResponseFrame, "type"> & {
  type: "local_get_response";
  localAuthToken?: string;
};

export type LocalSubmitResponseFrame = MessageResponse & {
  type: "local_submit_response";
  localAuthToken?: string;
};

export type HubFrame =
  | AuthHelloFrame
  | ClientAuthFrame
  | ListAgentsFrame
  | SendPromptFrame
  | LocalRegisterFrame
  | LocalUnregisterFrame
  | LocalSendPromptFrame
  | LocalGetResponseFrame
  | LocalSubmitResponseFrame
  | GetResponseFrame;

export type SendPromptRouteResult =
  | { ok: true; msgId: string; status: "delivered" }
  | { ok: false; error: string };

export type HubFrameResponse =
  | ServerHelloFrame
  | { type: "auth_ok"; peer: AuthenticatedPeer; publicKeyHex: string; signatureHex: string }
  | { type: "auth_failed"; reason: HandshakeFailureReason }
  | { type: "agents"; agents: LocalAgent[] }
  | { type: "local_register_ok"; agent: LocalAgent }
  | { type: "local_unregister_ok"; sessionId: string; removed: boolean }
  | { type: "response"; msgId: string; result: MessageResponseResult }
  | { type: "response_submitted"; msgId: string; status: "complete" | "error" }
  | { type: "response_rejected"; msgId: string; error: string }
  | { type: "send_accepted"; msgId: string; status: "delivered" }
  | { type: "send_rejected"; msgId: string; error: string }
  | { type: "error"; code: "invalid_frame" | "auth_required" | "unsupported_frame" };

export type MessageResponseResult = {
  status: string;
  response?: unknown;
  error?: string | null;
};

export type HubTransportAuthGateOptions = {
  authorizedKeys: AuthorizedSshEd25519Key[];
  now: () => Date;
  maxSkewMs: number;
  localIdentity: {
    nodeId: string;
    hubInstanceId: string;
    endpoint: () => string;
    publicKeyHex: string;
    privateKeyHex: string;
  };
  audit?: (event: AuditEventName, metadata: AuditMetadata) => void | Promise<void>;
};

export type HubFrameProcessorOptions = {
  gate: HubTransportAuthGate;
  localAuthToken?: string;
  listAgents: () => LocalAgent[];
  registerLocalAgent: (registration: LocalAgentRegistration) => LocalAgent;
  unregisterLocalAgent: (sessionId: string) => boolean;
  onSendPrompt: (frame: SendPromptFrame) => Promise<SendPromptRouteResult | void>;
  getResponse: (msgId: string) => MessageResponseResult;
  submitResponse: (response: MessageResponse) => SubmitResponseResult;
};

export type TransportAuthResult =
  | { ok: true; peer: AuthenticatedPeer; publicKeyHex: string; signatureHex: string }
  | { ok: false; reason: HandshakeFailureReason };

export class HubFrameProcessor {
  private authenticatedNodeId: string | null = null;

  constructor(private readonly options: HubFrameProcessorOptions) {}

  async handleRaw(raw: string | Buffer): Promise<HubFrameResponse> {
    const frame = parseFrame(raw);
    if (!frame) return { type: "error", code: "invalid_frame" };

    switch (frame.type) {
      case "auth_hello":
        return this.options.gate.createServerHello();
      case "client_auth":
        return this.handleClientAuth(frame);
      case "local_register":
        if (!this.isLocalAuthorized(frame.localAuthToken)) return { type: "error", code: "auth_required" };
        return { type: "local_register_ok", agent: this.options.registerLocalAgent(frame.registration) };
      case "local_unregister":
        if (!this.isLocalAuthorized(frame.localAuthToken)) return { type: "error", code: "auth_required" };
        return {
          type: "local_unregister_ok",
          sessionId: frame.sessionId,
          removed: this.options.unregisterLocalAgent(frame.sessionId),
        };
      case "local_get_response":
        if (!this.isLocalAuthorized(frame.localAuthToken)) return { type: "error", code: "auth_required" };
        return { type: "response", msgId: frame.msgId, result: this.options.getResponse(frame.msgId) };
      case "local_submit_response": {
        if (!this.isLocalAuthorized(frame.localAuthToken)) return { type: "error", code: "auth_required" };
        const result = this.options.submitResponse({
          msgId: frame.msgId,
          responderSessionId: frame.responderSessionId,
          response: frame.response,
          error: frame.error,
          completedAt: frame.completedAt,
        });
        if (!result.ok) return { type: "response_rejected", msgId: frame.msgId, error: result.error };
        return { type: "response_submitted", msgId: frame.msgId, status: result.status };
      }
      case "local_send_prompt": {
        if (!this.isLocalAuthorized(frame.localAuthToken)) return { type: "error", code: "auth_required" };
        const result = await this.options.onSendPrompt({ ...frame, type: "send_prompt" });
        if (result && !result.ok) {
          return { type: "send_rejected", msgId: frame.msgId, error: result.error };
        }
        return { type: "send_accepted", msgId: frame.msgId, status: "delivered" };
      }
      case "list_agents":
        if (!this.isAuthenticated()) return { type: "error", code: "auth_required" };
        return { type: "agents", agents: this.options.listAgents() };
      case "get_response":
        if (!this.isAuthenticated()) return { type: "error", code: "auth_required" };
        return { type: "response", msgId: frame.msgId, result: this.options.getResponse(frame.msgId) };
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
    return {
      type: "auth_ok",
      peer: result.peer,
      publicKeyHex: result.publicKeyHex,
      signatureHex: result.signatureHex,
    };
  }

  private isAuthenticated(): boolean {
    return this.authenticatedNodeId !== null && this.options.gate.canListAgents(this.authenticatedNodeId);
  }

  private isLocalAuthorized(token: string | undefined): boolean {
    return this.options.localAuthToken === undefined || token === this.options.localAuthToken;
  }
}

export class HubTransportAuthGate {
  private readonly replayCache = new ReplayCache();
  private readonly authenticated = new Map<string, AuthenticatedPeer>();
  private currentHello: ServerHelloPayload | null = null;

  constructor(private readonly options: HubTransportAuthGateOptions) {}

  createServerHello(): ServerHelloFrame {
    if (!this.currentHello) {
      const now = this.options.now().toISOString();
      this.currentHello = {
        protocol: "onclave",
        version: 1,
        server_node_id: this.options.localIdentity.nodeId,
        server_instance_id: this.options.localIdentity.hubInstanceId,
        server_endpoint: this.options.localIdentity.endpoint(),
        server_nonce: randomBytes(16).toString("hex"),
        server_timestamp: now,
      };
    }
    return { type: "server_hello", hello: this.currentHello };
  }

  localIdentity(): HubTransportAuthGateOptions["localIdentity"] {
    return this.options.localIdentity;
  }

  async authenticateClient(frame: ClientAuthFrame): Promise<TransportAuthResult> {
    const now = this.options.now();
    const expectedHello = this.currentHello;
    if (!expectedHello) {
      return { ok: false, reason: "invalid_payload" };
    }
    void this.options.audit?.("auth_attempt", { node_id: frame.payload.client_node_id });
    const result = await verifyClientHandshake({
      payload: frame.payload,
      signatureHex: frame.signatureHex,
      publicKeyHex: frame.publicKeyHex,
      authorizedKeys: this.options.authorizedKeys,
      replayCache: this.replayCache,
      now,
      maxSkewMs: this.options.maxSkewMs,
      expectedHello,
    });

    if (!result.ok) {
      void this.options.audit?.("auth_failure", {
        node_id: frame.payload.client_node_id,
        reason: result.reason,
      });
      return result;
    }

    const peer: AuthenticatedPeer = {
      nodeId: frame.payload.client_node_id,
      hubInstanceId: frame.payload.client_instance_id,
      endpoint: frame.payload.client_endpoint,
      fingerprint: result.fingerprint,
      authenticatedAt: now.toISOString(),
    };
    this.authenticated.set(peer.nodeId, peer);
    void this.options.audit?.("auth_success", {
      node_id: peer.nodeId,
      fingerprint: peer.fingerprint,
    });
    return {
      ok: true,
      peer,
      publicKeyHex: this.options.localIdentity.publicKeyHex,
      signatureHex: await signHandshakePayload(frame.payload, this.options.localIdentity.privateKeyHex),
    };
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
      case "auth_hello":
        return { type: "auth_hello" };
      case "client_auth":
        return isClientAuthFrame(record) ? record : null;
      case "list_agents":
        return { type: "list_agents" };
      case "local_register":
        return isLocalRegisterFrame(record) ? record : null;
      case "local_unregister":
        return isLocalUnregisterFrame(record) ? record : null;
      case "local_get_response":
        return isLocalGetResponseFrame(record) ? record : null;
      case "local_send_prompt":
        return isLocalSendPromptFrame(record) ? record : null;
      case "local_submit_response":
        return isLocalSubmitResponseFrame(record) ? record : null;
      case "get_response":
        return isGetResponseFrame(record) ? record : null;
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
    record.protocol === "onclave" &&
    record.version === 1 &&
    typeof record.client_node_id === "string" &&
    typeof record.server_node_id === "string" &&
    typeof record.client_instance_id === "string" &&
    typeof record.server_instance_id === "string" &&
    typeof record.client_endpoint === "string" &&
    typeof record.server_endpoint === "string" &&
    typeof record.client_nonce === "string" &&
    typeof record.server_nonce === "string" &&
    typeof record.client_timestamp === "string" &&
    typeof record.server_timestamp === "string"
  );
}

function isLocalRegisterFrame(value: Record<string, unknown>): value is LocalRegisterFrame {
  return value.type === "local_register" && isOptionalLocalAuthToken(value) && isLocalAgentRegistration(value.registration);
}

function isLocalUnregisterFrame(value: Record<string, unknown>): value is LocalUnregisterFrame {
  return value.type === "local_unregister" && isOptionalLocalAuthToken(value) && typeof value.sessionId === "string" && value.sessionId.length > 0;
}

function isOptionalLocalAuthToken(value: Record<string, unknown>): boolean {
  return value.localAuthToken === undefined || (typeof value.localAuthToken === "string" && value.localAuthToken.length > 0);
}

function isLocalAgentRegistration(value: unknown): value is LocalAgentRegistration {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.instanceId === "string" &&
    record.instanceId.length > 0 &&
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.projectLabel === "string" &&
    record.projectLabel.length > 0 &&
    typeof record.model === "string" &&
    record.model.length > 0 &&
    typeof record.purpose === "string" &&
    typeof record.color === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(record.color) &&
    typeof record.explicit === "boolean" &&
    typeof record.deliveryEndpoint === "string" &&
    record.deliveryEndpoint.length > 0
  );
}

function isGetResponseFrame(value: Record<string, unknown>): value is GetResponseFrame {
  return value.type === "get_response" && typeof value.msgId === "string" && value.msgId.length > 0;
}

function isLocalGetResponseFrame(value: Record<string, unknown>): value is LocalGetResponseFrame {
  return value.type === "local_get_response" && isOptionalLocalAuthToken(value) && typeof value.msgId === "string" && value.msgId.length > 0;
}

function isLocalSubmitResponseFrame(value: Record<string, unknown>): value is LocalSubmitResponseFrame {
  return (
    value.type === "local_submit_response" &&
    isOptionalLocalAuthToken(value) &&
    typeof value.msgId === "string" &&
    value.msgId.length > 0 &&
    typeof value.responderSessionId === "string" &&
    value.responderSessionId.length > 0 &&
    "response" in value &&
    (typeof value.error === "string" || value.error === null) &&
    typeof value.completedAt === "string" &&
    value.completedAt.length > 0
  );
}

function isLocalSendPromptFrame(value: Record<string, unknown>): value is LocalSendPromptFrame {
  return (
    value.type === "local_send_prompt" &&
    isOptionalLocalAuthToken(value) &&
    typeof value.msgId === "string" &&
    value.msgId.length > 0 &&
    typeof value.targetSessionId === "string" &&
    value.targetSessionId.length > 0 &&
    typeof value.prompt === "string" &&
    value.prompt.length <= MAX_FRAME_PROMPT_LENGTH &&
    typeof value.hops === "number" &&
    Number.isInteger(value.hops) &&
    value.hops >= 0 &&
    (value.replyMode === undefined || isPromptReplyMode(value.replyMode)) &&
    (value.origin === undefined || isPromptOriginMetadata(value.origin))
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
    value.prompt.length <= MAX_FRAME_PROMPT_LENGTH &&
    typeof value.hops === "number" &&
    Number.isInteger(value.hops) &&
    value.hops >= 0 &&
    (value.replyMode === undefined || isPromptReplyMode(value.replyMode)) &&
    (value.origin === undefined || isPromptOriginMetadata(value.origin))
  );
}
