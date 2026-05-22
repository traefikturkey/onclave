import { describe, expect, it } from "bun:test";
import { keygenAsync } from "@noble/ed25519";
import type { AuditEventName, AuditMetadata } from "../../src/coms-lan/audit";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import { signHandshakePayload, type HandshakePayload } from "../../src/coms-lan/handshake";
import { HubTransportAuthGate, type ClientAuthFrame } from "../../src/coms-lan/transport";

const NOW = "2026-05-21T00:00:00.000Z";

describe("HubTransportAuthGate", () => {
  it("blocks list and message privileges before authentication", () => {
    const gate = new HubTransportAuthGate({
      authorizedKeys: [],
      now: () => new Date(NOW),
      maxSkewMs: 30_000,
    });

    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });

  it("authenticates an authorized client, audits success, and enables v1 privileges", async () => {
    const fixture = await createClientAuthFrame();
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const gate = new HubTransportAuthGate({
      authorizedKeys: fixture.authorizedKeys,
      now: () => new Date(NOW),
      maxSkewMs: 30_000,
      audit: (event, metadata) => {
        events.push({ event, metadata });
      },
    });

    const result = await gate.authenticateClient(fixture.frame);

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
        endpoint: "wss://192.168.1.10:4444/v1/hub",
        fingerprint: fixture.authorizedKeys[0]?.fingerprint,
        authenticatedAt: NOW,
      },
    ]);
  });

  it("rejects unknown keys, audits failure, and keeps privileges blocked", async () => {
    const fixture = await createClientAuthFrame();
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const gate = new HubTransportAuthGate({
      authorizedKeys: [],
      now: () => new Date(NOW),
      maxSkewMs: 30_000,
      audit: (event, metadata) => {
        events.push({ event, metadata });
      },
    });

    const result = await gate.authenticateClient(fixture.frame);

    expect(result).toEqual({ ok: false, reason: "unknown_public_key" });
    expect(events).toEqual([
      { event: "auth_attempt", metadata: { node_id: "node_client" } },
      { event: "auth_failure", metadata: { node_id: "node_client", reason: "unknown_public_key" } },
    ]);
    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });

  it("rejects invalid signatures and keeps privileges blocked", async () => {
    const fixture = await createClientAuthFrame();
    const gate = new HubTransportAuthGate({
      authorizedKeys: fixture.authorizedKeys,
      now: () => new Date(NOW),
      maxSkewMs: 30_000,
    });
    const frame = {
      ...fixture.frame,
      payload: { ...fixture.frame.payload, client_endpoint: "wss://evil.example/v1/hub" },
    };

    const result = await gate.authenticateClient(frame);

    expect(result).toEqual({ ok: false, reason: "invalid_signature" });
    expect(gate.canListAgents("node_client")).toBe(false);
    expect(gate.canSendMessages("node_client")).toBe(false);
  });
});

async function createClientAuthFrame(): Promise<{
  frame: ClientAuthFrame;
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>;
}> {
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
  };

  return {
    authorizedKeys,
    frame: {
      type: "client_auth",
      payload,
      publicKeyHex,
      signatureHex: await signHandshakePayload(payload, privateKeyHex),
    },
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
