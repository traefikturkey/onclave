import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import {
  ReplayCache,
  verifyClientHandshake,
  type HandshakeFailureReason,
  type HandshakePayload,
} from "./handshake";

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

export type HubTransportAuthGateOptions = {
  authorizedKeys: AuthorizedSshEd25519Key[];
  now: () => Date;
  maxSkewMs: number;
};

export type TransportAuthResult =
  | { ok: true; peer: AuthenticatedPeer }
  | { ok: false; reason: HandshakeFailureReason };

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
