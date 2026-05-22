import { signAsync, verifyAsync } from "@noble/ed25519";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { canonicalJson, type CanonicalJsonValue } from "./canonical-json";

export type HandshakePayload = {
  protocol: "coms-lan";
  version: 1;
  client_node_id: string;
  server_node_id: string;
  client_instance_id: string;
  server_instance_id: string;
  client_endpoint: string;
  server_endpoint: string;
  client_nonce: string;
  server_nonce: string;
  timestamp: string;
};

export type HandshakeFailureReason =
  | "unknown_public_key"
  | "invalid_signature"
  | "stale_handshake"
  | "replayed_handshake"
  | "invalid_payload";

export type HandshakeVerificationResult =
  | { ok: true; fingerprint: string }
  | { ok: false; reason: HandshakeFailureReason };

export type VerifyClientHandshakeInput = {
  payload: HandshakePayload;
  signatureHex: string;
  publicKeyHex: string;
  authorizedKeys: AuthorizedSshEd25519Key[];
  replayCache: ReplayCache;
  now: Date;
  maxSkewMs: number;
};

export class ReplayCache {
  private readonly seen = new Set<string>();

  has(payload: HandshakePayload): boolean {
    return this.seen.has(replayKey(payload));
  }

  remember(payload: HandshakePayload): void {
    this.seen.add(replayKey(payload));
  }
}

export async function signHandshakePayload(
  payload: HandshakePayload,
  privateKeyHex: string
): Promise<string> {
  const message = new TextEncoder().encode(canonicalJson(payload as unknown as CanonicalJsonValue));
  const signature = await signAsync(message, hexToBytes(privateKeyHex));
  return bytesToHex(signature);
}

export async function verifyClientHandshake(
  input: VerifyClientHandshakeInput
): Promise<HandshakeVerificationResult> {
  if (!isValidHandshakePayload(input.payload)) {
    return { ok: false, reason: "invalid_payload" };
  }

  const authorizedKey = findAuthorizedKey(input.publicKeyHex, input.authorizedKeys);
  if (!authorizedKey) return { ok: false, reason: "unknown_public_key" };

  if (isStale(input.payload.timestamp, input.now, input.maxSkewMs)) {
    return { ok: false, reason: "stale_handshake" };
  }

  if (input.replayCache.has(input.payload)) {
    return { ok: false, reason: "replayed_handshake" };
  }

  const message = new TextEncoder().encode(canonicalJson(input.payload as unknown as CanonicalJsonValue));
  const signature = safeHexToBytes(input.signatureHex);
  if (!signature) return { ok: false, reason: "invalid_signature" };

  const verified = await verifyAsync(signature, message, authorizedKey.publicKeyBytes);
  if (!verified) return { ok: false, reason: "invalid_signature" };

  input.replayCache.remember(input.payload);
  return { ok: true, fingerprint: authorizedKey.fingerprint };
}

function findAuthorizedKey(
  publicKeyHex: string,
  authorizedKeys: AuthorizedSshEd25519Key[]
): AuthorizedSshEd25519Key | null {
  const publicKey = safeHexToBytes(publicKeyHex);
  if (!publicKey || publicKey.length !== 32) return null;

  for (const key of authorizedKeys) {
    if (bytesEqual(publicKey, key.publicKeyBytes)) return key;
  }
  return null;
}

function isValidHandshakePayload(payload: HandshakePayload): boolean {
  return (
    payload.protocol === "coms-lan" &&
    payload.version === 1 &&
    nonEmpty(payload.client_node_id) &&
    nonEmpty(payload.server_node_id) &&
    nonEmpty(payload.client_instance_id) &&
    nonEmpty(payload.server_instance_id) &&
    nonEmpty(payload.client_endpoint) &&
    nonEmpty(payload.server_endpoint) &&
    nonEmpty(payload.client_nonce) &&
    nonEmpty(payload.server_nonce) &&
    nonEmpty(payload.timestamp)
  );
}

function nonEmpty(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function isStale(timestamp: string, now: Date, maxSkewMs: number): boolean {
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return true;
  return Math.abs(now.getTime() - parsed) > maxSkewMs;
}

function replayKey(payload: HandshakePayload): string {
  return [
    payload.client_node_id,
    payload.server_node_id,
    payload.client_instance_id,
    payload.server_instance_id,
    payload.client_nonce,
    payload.server_nonce,
  ].join("\0");
}

function safeHexToBytes(value: string): Uint8Array | null {
  if (!/^(?:[a-f0-9]{2})+$/i.test(value)) return null;
  return hexToBytes(value);
}

function hexToBytes(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "hex"));
}

function bytesToHex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}
