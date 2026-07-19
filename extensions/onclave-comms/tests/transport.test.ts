import { describe, expect, it } from "vitest";
import { keygenAsync } from "@noble/ed25519";
import type { AuditEventName, AuditMetadata } from "../src/lib/audit";
import { parseAuthorizedKeys } from "../src/lib/authorized-keys";
import {
  signHandshakePayload,
  type HandshakePayload,
  type ServerHelloFrame,
} from "../src/lib/handshake";
import { HubTransportAuthGate, type ClientAuthFrame } from "../src/lib/transport";

const NOW = "2026-05-21T00:00:00.000Z";

describe("HubTransportAuthGate", () => {
  it("blocks list and message privileges before authentication", async () => {
    const gate = await createGate([]);

    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });

  it("issues a server hello with a fresh server nonce", async () => {
    const gate = await createGate([]);

    expect(gate.createServerHello()).toMatchObject({
      type: "server_hello",
      hello: {
        protocol: "onclave",
        version: 1,
        server_node_id: "node_server",
        server_instance_id: "hub_server",
        server_endpoint: "wss://192.0.2.20:4444/v1/hub",
        server_timestamp: NOW,
      },
    });
    expect(gate.createServerHello().hello.server_nonce).toEqual(gate.createServerHello().hello.server_nonce);
  });

  it("authenticates an authorized client, audits success, and enables v1 privileges", async () => {
    const fixture = await createClientAuthFixture();
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const gate = await createGate(fixture.authorizedKeys, events);

    const hello = gate.createServerHello();
    const result = await gate.authenticateClient(await createClientAuthFrame(hello, fixture.privateKeyHex, fixture.publicKeyHex));

    expect(result.ok).toBe(true);
    expect(gate.canListAgents("node_client")).toBe(true);
    expect(gate.canSendMessages("node_client")).toBe(true);
    expect(events).toEqual([
      { event: "auth_attempt", metadata: { node_id: "node_client" } },
      { event: "auth_success", metadata: { node_id: "node_client", fingerprint: fixture.authorizedKeys[0]?.fingerprint } },
    ]);
    expect(gate.authenticatedPeers()).toEqual([
      {
        nodeId: "node_client",
        hubInstanceId: "hub_client",
        endpoint: "wss://192.0.2.10:4444/v1/hub",
        fingerprint: fixture.authorizedKeys[0]?.fingerprint,
        authenticatedAt: NOW,
      },
    ]);
    if (result.ok) {
      expect(result.publicKeyHex).toBe(gate.localIdentity().publicKeyHex);
      expect(result.signatureHex).toMatch(/^[a-f0-9]+$/);
    }
  });

  it("rejects unknown keys, audits failure, and keeps privileges blocked", async () => {
    const fixture = await createClientAuthFixture();
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const gate = await createGate([], events);

    const hello = gate.createServerHello();
    const result = await gate.authenticateClient(await createClientAuthFrame(hello, fixture.privateKeyHex, fixture.publicKeyHex));

    expect(result).toEqual({ ok: false, reason: "unknown_public_key" });
    expect(events).toEqual([
      { event: "auth_attempt", metadata: { node_id: "node_client" } },
      { event: "auth_failure", metadata: { node_id: "node_client", reason: "unknown_public_key" } },
    ]);
    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });

  it("rejects invalid signatures and keeps privileges blocked", async () => {
    const fixture = await createClientAuthFixture();
    const gate = await createGate(fixture.authorizedKeys);
    const hello = gate.createServerHello();
    const frame = await createClientAuthFrame(hello, fixture.privateKeyHex, fixture.publicKeyHex);
    const tampered = {
      ...frame,
      payload: { ...frame.payload, client_endpoint: "wss://evil.example/v1/hub" },
    };

    const result = await gate.authenticateClient(tampered);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });
});

async function createGate(
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>,
  events?: Array<{ event: AuditEventName; metadata: AuditMetadata }>
) {
  const serverKeyPair = await keygenAsync();
  return new HubTransportAuthGate({
    authorizedKeys,
    now: () => new Date(NOW),
    maxSkewMs: 30_000,
    localIdentity: {
      nodeId: "node_server",
      hubInstanceId: "hub_server",
      endpoint: () => "wss://192.0.2.20:4444/v1/hub",
      publicKeyHex: Buffer.from(serverKeyPair.publicKey).toString("hex"),
      privateKeyHex: Buffer.from(serverKeyPair.secretKey).toString("hex"),
    },
    audit: events
      ? (event, metadata) => {
          events.push({ event, metadata });
        }
      : undefined,
  });
}

async function createClientAuthFixture(): Promise<{
  publicKeyHex: string;
  privateKeyHex: string;
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>;
}> {
  const keyPair = await keygenAsync();
  const publicKeyHex = Buffer.from(keyPair.publicKey).toString("hex");
  const privateKeyHex = Buffer.from(keyPair.secretKey).toString("hex");
  const authorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(keyPair.publicKey)} test@example`
  );

  return {
    publicKeyHex,
    privateKeyHex,
    authorizedKeys,
  };
}

async function createClientAuthFrame(
  hello: ServerHelloFrame,
  privateKeyHex: string,
  publicKeyHex: string
): Promise<ClientAuthFrame> {
  const payload: HandshakePayload = {
    protocol: "onclave",
    version: 1,
    client_node_id: "node_client",
    server_node_id: hello.hello.server_node_id,
    client_instance_id: "hub_client",
    server_instance_id: hello.hello.server_instance_id,
    client_endpoint: "wss://192.0.2.10:4444/v1/hub",
    server_endpoint: hello.hello.server_endpoint,
    client_nonce: "client-nonce",
    server_nonce: hello.hello.server_nonce,
    client_timestamp: NOW,
    server_timestamp: hello.hello.server_timestamp,
  };

  return {
    type: "client_auth",
    payload,
    publicKeyHex,
    signatureHex: await signHandshakePayload(payload, privateKeyHex),
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
