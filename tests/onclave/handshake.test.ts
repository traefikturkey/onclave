import { describe, expect, it } from "bun:test";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/onclave/authorized-keys";
import {
  ReplayCache,
  signHandshakePayload,
  verifyClientHandshake,
  verifyServerHandshake,
  type HandshakePayload,
  type ServerHelloPayload,
} from "../../src/onclave/handshake";

const NOW = "2026-05-21T00:00:00.000Z";

describe("hub challenge-response handshake", () => {
  it("accepts a valid authorized Ed25519 signature bound to a server hello", async () => {
    const fixture = await createFixture();

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    if (!result.ok) throw new Error(`expected handshake success, got ${result.reason}`);
    expect(result.fingerprint).toBe(fixture.clientAuthorizedKeys[0]?.fingerprint);
  });

  it("rejects unknown public keys", async () => {
    const fixture = await createFixture();

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: [],
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    expect(result).toEqual({ ok: false, reason: "unknown_public_key" });
  });

  it("rejects invalid signatures", async () => {
    const fixture = await createFixture();
    const tampered = { ...fixture.payload, client_endpoint: "wss://evil.example/v1/hub" };

    const result = await verifyClientHandshake({
      payload: tampered,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
  });

  it("rejects payloads that do not match the issued server hello", async () => {
    const fixture = await createFixture();
    const mismatched = { ...fixture.payload, server_nonce: "other-server-nonce" };

    const result = await verifyClientHandshake({
      payload: mismatched,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    expect(result).toEqual({ ok: false, reason: "invalid_payload" });
  });

  it("rejects stale handshakes", async () => {
    const fixture = await createFixture({
      serverHello: { server_timestamp: "2026-05-20T23:00:00.000Z" },
      payload: { client_timestamp: "2026-05-20T23:00:00.000Z", server_timestamp: "2026-05-20T23:00:00.000Z" },
    });

    const result = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache: new ReplayCache(),
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    expect(result).toEqual({ ok: false, reason: "stale_handshake" });
  });

  it("rejects replayed nonce pairs", async () => {
    const fixture = await createFixture();
    const replayCache = new ReplayCache();

    const first = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache,
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });
    const second = await verifyClientHandshake({
      payload: fixture.payload,
      signatureHex: fixture.clientSignatureHex,
      publicKeyHex: fixture.clientPublicKeyHex,
      authorizedKeys: fixture.clientAuthorizedKeys,
      replayCache,
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedHello: fixture.serverHello,
    });

    expect(first.ok).toBe(true);
    expect(second).toEqual({ ok: false, reason: "replayed_handshake" });
  });

  it("accepts a valid authorized server signature over the handshake payload", async () => {
    const fixture = await createFixture();

    const result = await verifyServerHandshake({
      payload: fixture.payload,
      signatureHex: fixture.serverSignatureHex,
      publicKeyHex: fixture.serverPublicKeyHex,
      authorizedKeys: fixture.serverAuthorizedKeys,
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedServer: {
        nodeId: fixture.serverHello.server_node_id,
        hubInstanceId: fixture.serverHello.server_instance_id,
        endpoint: fixture.serverHello.server_endpoint,
      },
    });

    if (!result.ok) throw new Error(`expected server verification success, got ${result.reason}`);
    expect(result.fingerprint).toBe(fixture.serverAuthorizedKeys[0]?.fingerprint);
  });

  it("rejects unknown server keys", async () => {
    const fixture = await createFixture();

    const result = await verifyServerHandshake({
      payload: fixture.payload,
      signatureHex: fixture.serverSignatureHex,
      publicKeyHex: fixture.serverPublicKeyHex,
      authorizedKeys: [],
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedServer: {
        nodeId: fixture.serverHello.server_node_id,
        hubInstanceId: fixture.serverHello.server_instance_id,
        endpoint: fixture.serverHello.server_endpoint,
      },
    });

    expect(result).toEqual({ ok: false, reason: "unknown_public_key" });
  });

  it("rejects tampered server auth responses", async () => {
    const fixture = await createFixture();

    const result = await verifyServerHandshake({
      payload: { ...fixture.payload, server_endpoint: "wss://evil.example/v1/hub" },
      signatureHex: fixture.serverSignatureHex,
      publicKeyHex: fixture.serverPublicKeyHex,
      authorizedKeys: fixture.serverAuthorizedKeys,
      now: new Date(NOW),
      maxSkewMs: 30_000,
      expectedServer: {
        nodeId: fixture.serverHello.server_node_id,
        hubInstanceId: fixture.serverHello.server_instance_id,
        endpoint: fixture.serverHello.server_endpoint,
      },
    });

    expect(result).toEqual({ ok: false, reason: "invalid_payload" });
  });
});

async function createFixture(overrides: {
  serverHello?: Partial<ServerHelloPayload>;
  payload?: Partial<HandshakePayload>;
} = {}) {
  const clientKeyPair = await keygenAsync();
  const serverKeyPair = await keygenAsync();
  const clientPublicKeyHex = Buffer.from(clientKeyPair.publicKey).toString("hex");
  const clientPrivateKeyHex = Buffer.from(clientKeyPair.secretKey).toString("hex");
  const serverPublicKeyHex = Buffer.from(serverKeyPair.publicKey).toString("hex");
  const serverPrivateKeyHex = Buffer.from(serverKeyPair.secretKey).toString("hex");
  const clientAuthorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(clientKeyPair.publicKey)} client@example`
  );
  const serverAuthorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(serverKeyPair.publicKey)} server@example`
  );
  const serverHello: ServerHelloPayload = {
    protocol: "onclave",
    version: 1,
    server_node_id: "node_server",
    server_instance_id: "hub_server",
    server_endpoint: "wss://192.168.1.20:4444/v1/hub",
    server_nonce: "server-nonce",
    server_timestamp: NOW,
    ...overrides.serverHello,
  };
  const payload: HandshakePayload = {
    protocol: "onclave",
    version: 1,
    client_node_id: "node_client",
    server_node_id: serverHello.server_node_id,
    client_instance_id: "hub_client",
    server_instance_id: serverHello.server_instance_id,
    client_endpoint: "wss://192.168.1.10:4444/v1/hub",
    server_endpoint: serverHello.server_endpoint,
    client_nonce: "client-nonce",
    server_nonce: serverHello.server_nonce,
    client_timestamp: NOW,
    server_timestamp: serverHello.server_timestamp,
    ...overrides.payload,
  };
  const clientSignatureHex = await signHandshakePayload(payload, clientPrivateKeyHex);
  const serverSignatureHex = await signHandshakePayload(payload, serverPrivateKeyHex);

  return {
    serverHello,
    payload,
    clientSignatureHex,
    serverSignatureHex,
    clientPublicKeyHex,
    serverPublicKeyHex,
    clientAuthorizedKeys,
    serverAuthorizedKeys,
  };
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
