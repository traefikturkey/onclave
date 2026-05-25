import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../packages/core/src/onclave/authorized-keys";
import type { RemoteHubClientIdentity } from "../../packages/core/src/onclave/remote-client";
import type { LocalAgent } from "../../packages/core/src/onclave/local-registry";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type ClientAuthFrame,
} from "../../packages/core/src/onclave/transport";
import {
  signHandshakePayload,
  type HandshakePayload,
  type ServerHelloFrame,
} from "../../packages/core/src/onclave/handshake";
import {
  sendAuthenticatedWssFrames,
  sendWssFrames,
  startWssHubServer,
  type TlsMaterial,
} from "../../packages/core/src/onclave/wss-transport";

const NOW = "2026-05-21T00:00:00.000Z";
let tempDir: string | null = null;
let tls: TlsMaterial;

beforeAll(async () => {
  const generated = await generateSelfSignedTls();
  tempDir = generated.tempDir;
  tls = generated.tls;
});

afterAll(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

describe("WSS hub transport", () => {
  it("returns auth_required for gated frames before authentication", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const serverIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const server = await startTestServer([], serverIdentity);
    try {
      const responses = await sendWssFrames(server.url, [{ type: "list_agents" }], {
        rejectUnauthorized: false,
      });

      expect(responses).toEqual([{ type: "error", code: "auth_required" }]);
    } finally {
      server.stop();
    }
  });

  it("issues a server hello, authenticates, and handles gated frames on the same WSS connection", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const serverIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const authorizedKeys = parseAuthorizedKeys(
      `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(clientIdentity.publicKeyHex, "hex"))} test@example`
    );
    const agent = createAgent();
    const server = await startTestServer(authorizedKeys, serverIdentity, [agent]);
    try {
      const responses = await sendAuthenticatedWssFrames(server.url, {
        createAuthFrame: (hello) => createClientAuthFrame(clientIdentity, hello),
        frames: [{ type: "list_agents" }],
        rejectUnauthorized: false,
      });

      expect(responses[0]).toMatchObject({
        type: "server_hello",
        hello: { server_node_id: serverIdentity.nodeId },
      });
      expect(responses[1]).toMatchObject({
        type: "auth_ok",
        peer: { nodeId: "node_client" },
      });
      expect(responses[2]).toEqual({ type: "agents", agents: [agent] });
    } finally {
      server.stop();
    }
  });
});

async function startTestServer(
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>,
  serverIdentity: RemoteHubClientIdentity,
  agents: LocalAgent[] = []
) {
  return startWssHubServer({
    host: "127.0.0.1",
    port: 0,
    tls,
    createProcessor: () =>
      new HubFrameProcessor({
        gate: new HubTransportAuthGate({
          authorizedKeys,
          now: () => new Date(NOW),
          maxSkewMs: 30_000,
          localIdentity: {
            nodeId: serverIdentity.nodeId,
            hubInstanceId: serverIdentity.hubInstanceId,
            endpoint: () => serverIdentity.endpoint,
            publicKeyHex: serverIdentity.publicKeyHex,
            privateKeyHex: serverIdentity.privateKeyHex,
          },
        }),
        listAgents: () => agents,
        registerLocalAgent: (registration) => ({ ...registration, status: "online", queueDepth: 0, contextUsedPct: 0, registeredAt: NOW, lastSeenAt: NOW }),
        unregisterLocalAgent: () => false,
        onSendPrompt: async () => undefined,
        getResponse: () => ({ status: "unknown", error: "message_not_found" }),
        submitResponse: () => ({ ok: false, error: "message_not_found" }),
      }),
  });
}

async function createIdentity(nodeId: string, hubInstanceId: string, endpoint: string): Promise<RemoteHubClientIdentity> {
  const keyPair = await keygenAsync();
  return {
    nodeId,
    hubInstanceId,
    endpoint,
    publicKeyHex: Buffer.from(keyPair.publicKey).toString("hex"),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
  };
}

async function generateSelfSignedTls(): Promise<{ tempDir: string; tls: TlsMaterial }> {
  const dir = await mkdtemp(join(tmpdir(), "onclave-wss-"));
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

function createAgent(): LocalAgent {
  return {
    sessionId: "session-1",
    instanceId: "pi-instance-1",
    name: "agent-one",
    projectLabel: "onclave@main",
    model: "test-model",
    purpose: "testing",
    color: "#336699",
    explicit: false,
    deliveryEndpoint: "local://session-1",
    status: "online",
    queueDepth: 0,
    contextUsedPct: 0,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
}

async function createClientAuthFrame(identity: RemoteHubClientIdentity, hello: ServerHelloFrame): Promise<ClientAuthFrame> {
  const payload: HandshakePayload = {
    protocol: "onclave",
    version: 1,
    client_node_id: identity.nodeId,
    server_node_id: hello.hello.server_node_id,
    client_instance_id: identity.hubInstanceId,
    server_instance_id: hello.hello.server_instance_id,
    client_endpoint: identity.endpoint,
    server_endpoint: hello.hello.server_endpoint,
    client_nonce: "client-nonce",
    server_nonce: hello.hello.server_nonce,
    client_timestamp: NOW,
    server_timestamp: hello.hello.server_timestamp,
  };
  return {
    type: "client_auth",
    payload,
    publicKeyHex: identity.publicKeyHex,
    signatureHex: await signHandshakePayload(payload, identity.privateKeyHex),
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
