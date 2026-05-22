import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import { signHandshakePayload, type HandshakePayload } from "../../src/coms-lan/handshake";
import type { LocalAgent } from "../../src/coms-lan/local-registry";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type ClientAuthFrame,
} from "../../src/coms-lan/transport";
import { sendWssFrames, startWssHubServer, type TlsMaterial } from "../../src/coms-lan/wss-transport";

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
    const server = await startTestServer([]);
    try {
      const responses = await sendWssFrames(server.url, [{ type: "list_agents" }], {
        rejectUnauthorized: false,
      });

      expect(responses).toEqual([{ type: "error", code: "auth_required" }]);
    } finally {
      server.stop();
    }
  });

  it("authenticates and handles gated frames on the same WSS connection", async () => {
    const fixture = await createClientAuthFrame();
    const agent = createAgent();
    const server = await startTestServer(fixture.authorizedKeys, [agent]);
    try {
      const responses = await sendWssFrames(
        server.url,
        [fixture.frame, { type: "list_agents" }],
        { rejectUnauthorized: false }
      );

      expect(responses[0]).toMatchObject({
        type: "auth_ok",
        peer: { nodeId: "node_client" },
      });
      expect(responses[1]).toEqual({ type: "agents", agents: [agent] });
    } finally {
      server.stop();
    }
  });
});

async function startTestServer(authorizedKeys: ReturnType<typeof parseAuthorizedKeys>, agents: LocalAgent[] = []) {
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

async function generateSelfSignedTls(): Promise<{ tempDir: string; tls: TlsMaterial }> {
  const dir = await mkdtemp(join(tmpdir(), "coms-lan-wss-"));
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
    server_endpoint: "wss://127.0.0.1:4444/v1/hub",
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
