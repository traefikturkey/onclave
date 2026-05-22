import { describe, expect, it } from "bun:test";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import {
  ReplayCache,
  signHandshakePayload,
  verifyClientHandshake,
  type HandshakePayload,
} from "../../src/coms-lan/handshake";

const NOW = "2026-05-21T00:00:00.000Z";

describe("hub challenge-response handshake", () => {
  it("accepts a valid authorized Ed25519 signature", async () => {
    const fixture = await createFixture();

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: fixture.authorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });

    if (!result.ok) throw new Error(`expected handshake success, got ${result.reason}`);
    expect(result.fingerprint).toBe(fixture.authorizedKeys[0]?.fingerprint);
  });

  it("rejects unknown public keys", async () => {
    const fixture = await createFixture();

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: [],
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });

    expect(result).toEqual({ ok: false, reason: "unknown_public_key" });
  });

  it("rejects invalid signatures", async () => {
    const fixture = await createFixture();
    const tampered = { ...fixture.payload, client_endpoint: "wss://evil.example/v1/hub" };

    const result = await verifyClientHandshake({
      payload: tampered,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: fixture.authorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects stale handshakes", async () => {
    const fixture = await createFixture({ timestamp: "2026-05-20T23:00:00.000Z" });

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: fixture.authorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });

    expect(result).toEqual({ ok: false, reason: "stale_handshake" });
  });

  it("rejects replayed nonce pairs", async () => {
    const fixture = await createFixture();
    const replayCache = new ReplayCache();

    const first = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: fixture.authorizedKeys,
      replayCache,
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });
    const second = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.signatureHex,
      publicKeyHex: fixture.publicKeyHex,
      authorizedKeys: fixture.authorizedKeys,
      replayCache,
      now: new Date(NOW),
      maxSkewMs: 30_000,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "replayed_handshake" });
  });
});

async function createFixture(overrides: Partial<HandshakePayload> = {}) {
  const keyPair = await keygenAsync();
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
  const privateKeyHex = Buffer.from(keyPair.secretKey).toString("hex");
  const authorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(keyPair.publicKey)} test@example`
  );
  const payload: HandshakePayload = {
    protocol: "coms-lan",
    version: 1,
    client_node_id: "node_client",
    server_node_id: "node_server",
    client_instance_id: "hub_client",
    server_instance_id: "hub_server",
    client_endpoint: "wss://192.168.1.10:4444/v1/hub",
    server_endpoint: "wss://192.168.1.20:4444/v1/hub",
    client_nonce: "client-nonce",
    server_nonce: "server-nonce",
    timestamp: NOW,
    ...overrides,
  };
  const signatureHex = await signHandshakePayload(payload, privateKeyHex);

  return { payload, signatureHex, publicKeyHex, authorizedKeys };
}

function encodeOpenSshEd25519PublicKey(publicKey: Uint8Array): string {
  return Buffer.concat([
    encodeSshString(Buffer.from("ssh-ed25519", "utf8")),
    encodeSshString(Buffer.from(publicKey)),
  ]).toString("base64");
}

function encodeSshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}
