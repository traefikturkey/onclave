import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../src/lib/authorized-keys";
import { bootstrapLocalHub, type BootstrapLocalHubResult } from "../src/lib/bootstrap";
import type { DiscoveryUdpSocket, UdpRemoteInfo } from "../src/lib/discovery";
import { OnclaveHubRuntime } from "../src/lib/hub-runtime";
import type { LocalAgentRegistration } from "../src/lib/local-registry";
import { createRemoteHubClient, type RemoteHubClientIdentity } from "../src/lib/remote-client";
import { getOnclavePaths } from "../src/lib/state";
import { sendWssFrames, type TlsMaterial } from "../src/lib/wss-transport";

const NOW = "2026-05-21T00:00:00.000Z";
const DISCOVERY_PORT = 48901;
let tlsTempDir: string | null = null;
let tls: TlsMaterial;
const tempDirs: string[] = [];

beforeAll(async () => {
  const generated = await generateSelfSignedTls();
  tlsTempDir = generated.tempDir;
  tls = generated.tls;
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  if (tlsTempDir) await rm(tlsTempDir, { recursive: true, force: true });
});

describe("onclave acceptance coverage", () => {
  it("starts one local hub, reuses it, registers through WSS, and completes a local round trip", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-acceptance-bootstrap-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    const discoverySocket = new FakeUdpSocket();
    const delivered: unknown[] = [];
    let first: BootstrapLocalHubResult | null = null;

    try {
      first = await bootstrapLocalHub(paths, {
        host: "127.0.0.1",
        discoveryPort: DISCOVERY_PORT,
        broadcastAddress: "255.255.255.255",
        now: () => NOW,
        healthCheck: async () => false,
        tlsGenerator: async () => tls,
        discoverySocketFactory: () => discoverySocket,
        deliverPrompt: async (prompt) => {
          delivered.push(prompt);
        },
      });

      const second = await bootstrapLocalHub(paths, {
        host: "127.0.0.1",
        discoveryPort: DISCOVERY_PORT,
        broadcastAddress: "255.255.255.255",
        now: () => NOW,
        healthCheck: async (endpoint) => endpoint === first?.state.endpoint,
        tlsGenerator: async () => {
          throw new Error("second bootstrap should reuse the existing live hub");
        },
        discoverySocketFactory: () => {
          throw new Error("second bootstrap should not start discovery");
        },
      });

      expect(first.started).toBe(true);
      expect(first.runtime).toBeDefined();
      expect(second.started).toBe(false);
      expect(second.runtime).toBeNull();
      expect(second.state).toEqual(first.state);

      const discoveryPacket = JSON.parse(discoverySocket.sent[0]?.data.toString("utf8") ?? "{}");
      expect(discoveryPacket).toMatchObject({
        node_id: first.state.nodeId,
        hub_instance_id: first.state.hubInstanceId,
      });
      expect(JSON.stringify(discoveryPacket)).not.toMatch(/prompt|response|cwd|path|token|secret|key/i);

      const responses = await sendWssFrames(
        hubStateToWssUrl(first.state.endpoint),
        [
          { type: "local_register", registration: createRegistration("session-local") },
          {
            type: "local_send_prompt",
            msgId: "msg-local-1",
            targetSessionId: "session-local",
            prompt: "local prompt body",
            hops: 0,
          },
          {
            type: "local_submit_response",
            msgId: "msg-local-1",
            responderSessionId: "session-local",
            response: "local response body",
            error: null,
            completedAt: NOW,
          },
          { type: "local_get_response", msgId: "msg-local-1" },
        ],
        { rejectUnauthorized: false }
      );

      expect(responses[0]).toMatchObject({ type: "local_register_ok", agent: { sessionId: "session-local" } });
      expect(responses[1]).toEqual({ type: "send_accepted", msgId: "msg-local-1", status: "delivered" });
      expect(responses[2]).toEqual({ type: "response_submitted", msgId: "msg-local-1", status: "complete" });
      expect(responses[3]).toEqual({
        type: "response",
        msgId: "msg-local-1",
        result: { status: "complete", response: "local response body", error: null },
      });
      expect(delivered).toEqual([
        {
          msgId: "msg-local-1",
          targetSessionId: "session-local",
          deliveryEndpoint: "local://session-local",
          prompt: "local prompt body",
          hops: 0,
          receivedAt: NOW,
        },
      ]);
    } finally {
      await first?.runtime?.stop();
    }
  });

  it("lists and sends to a trusted remote hub after public keys are exchanged", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client");
    const serverIdentity = await createIdentity("node_server", "hub_server");
    const serverDelivered: unknown[] = [];
    const server = new OnclaveHubRuntime({
      nodeId: serverIdentity.nodeId,
      hubInstanceId: serverIdentity.hubInstanceId,
      host: "127.0.0.1",
      tls,
      authorizedKeys: authorizedKeysFor(clientIdentity, "client@example"),
      localPublicKeyHex: serverIdentity.publicKeyHex,
      localPrivateKeyHex: serverIdentity.privateKeyHex,
      discoverySocket: new FakeUdpSocket(),
      discoveryPort: DISCOVERY_PORT + 1,
      broadcastAddress: "255.255.255.255",
      startedAt: NOW,
      now: () => NOW,
      staleAfterMs: 30_000,
      offlineAfterMs: 60_000,
      deliverPrompt: async (prompt) => {
        serverDelivered.push(prompt);
      },
    });

    await server.start();
    try {
      const agent = server.registerLocalAgent(createRegistration("session-remote"));
      const client = createRemoteHubClient({
        identity: { ...clientIdentity, endpoint: "wss://127.0.0.1:0/v1/hub" },
        authorizedKeys: authorizedKeysFor(serverIdentity, "server@example"),
        remote: {
          nodeId: serverIdentity.nodeId,
          hubInstanceId: serverIdentity.hubInstanceId,
          endpoint: server.wssUrl(),
        },
        now: () => NOW,
        rejectUnauthorized: false,
      });

      await expect(client.listAgents()).resolves.toEqual([agent]);
      await expect(
        client.sendPrompt({
          msgId: "msg-remote-1",
          targetSessionId: "session-remote",
          prompt: "remote prompt body",
          hops: 0,
        })
      ).resolves.toEqual({ type: "send_accepted", msgId: "msg-remote-1", status: "delivered" });
      expect(serverDelivered).toEqual([
        {
          msgId: "msg-remote-1",
          targetSessionId: "session-remote",
          deliveryEndpoint: "local://session-remote",
          prompt: "remote prompt body",
          hops: 0,
          receivedAt: NOW,
        },
      ]);
    } finally {
      await server.stop();
    }
  });
});

class FakeUdpSocket implements DiscoveryUdpSocket {
  sent: Array<{ data: Buffer; port: number; address: string }> = [];
  closed = false;

  async bind(_port: number): Promise<void> {}
  setBroadcast(_enabled: boolean): void {}
  onMessage(_handler: (data: Buffer, remote: UdpRemoteInfo) => void): void {}

  async send(data: Buffer, port: number, address: string): Promise<void> {
    this.sent.push({ data, port, address });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function createIdentity(nodeId: string, hubInstanceId: string): Promise<RemoteHubClientIdentity> {
  const keyPair = await keygenAsync();
  return {
    nodeId,
    hubInstanceId,
    endpoint: "wss://127.0.0.1:0/v1/hub",
    publicKeyHex: Buffer.from(keyPair.publicKey).toString("hex"),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
  };
}

function authorizedKeysFor(identity: RemoteHubClientIdentity, comment: string) {
  return parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(identity.publicKeyHex, "hex"))} ${comment}`
  );
}

function createRegistration(sessionId: string): LocalAgentRegistration {
  return {
    sessionId,
    instanceId: `pi-${sessionId}`,
    name: `agent-${sessionId}`,
    projectLabel: "onclave@main",
    model: "test-model",
    purpose: "acceptance",
    color: "#336699",
    explicit: false,
    deliveryEndpoint: `local://${sessionId}`,
  };
}

function hubStateToWssUrl(endpoint: string): string {
  return `${endpoint.replace(/^https:/, "wss:")}/v1/hub`;
}

async function generateSelfSignedTls(): Promise<{ tempDir: string; tls: TlsMaterial }> {
  const dir = await mkdtemp(join(tmpdir(), "onclave-acceptance-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      "key.pem",
      "-out",
      "cert.pem",
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    {
      cwd: dir,
      env: { ...process.env, MSYS_NO_PATHCONV: "1" },
      stdio: "ignore",
    }
  );

  return {
    tempDir: dir,
    tls: {
      cert: await readFile(join(dir, "cert.pem"), "utf8"),
      key: await readFile(join(dir, "key.pem"), "utf8"),
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
