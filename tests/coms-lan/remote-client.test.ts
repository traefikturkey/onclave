import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import type { LocalAgent } from "../../src/coms-lan/local-registry";
import {
  createRemoteHubClient,
  type RemoteHubClientIdentity,
} from "../../src/coms-lan/remote-client";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type SendPromptFrame,
} from "../../src/coms-lan/transport";
import { startWssHubServer, type TlsMaterial } from "../../src/coms-lan/wss-transport";

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

describe("RemoteHubClient", () => {
  it("authenticates and lists remote agents", async () => {
    const identity = await createClientIdentity();
    const agent = createAgent();
    const server = await startTestServer(identity, { agents: [agent] });
    try {
      const client = createRemoteHubClient({
        identity,
        remote: {
          nodeId: "node_server",
          hubInstanceId: "hub_server",
          endpoint: server.url,
        },
        now: () => NOW,
        rejectUnauthorized: false,
      });

      await expect(client.listAgents()).resolves.toEqual([agent]);
    } finally {
      server.stop();
    }
  });

  it("authenticates and sends a prompt to the remote hub", async () => {
    const identity = await createClientIdentity();
    const sent: SendPromptFrame[] = [];
    const server = await startTestServer(identity, {
      onSendPrompt: async (frame) => {
        sent.push(frame);
        return { ok: true, msgId: frame.msgId, status: "delivered" };
      },
    });
    try {
      const client = createRemoteHubClient({
        identity,
        remote: {
          nodeId: "node_server",
          hubInstanceId: "hub_server",
          endpoint: server.url,
        },
        now: () => NOW,
        rejectUnauthorized: false,
      });

      await expect(
        client.sendPrompt({
          msgId: "msg-1",
          targetSessionId: "session-1",
          prompt: "hello",
          hops: 0,
        })
      ).resolves.toEqual({ type: "send_accepted", msgId: "msg-1", status: "delivered" });
      expect(sent).toEqual([
        {
          type: "send_prompt",
          msgId: "msg-1",
          targetSessionId: "session-1",
          prompt: "hello",
          hops: 0,
        },
      ]);
    } finally {
      server.stop();
    }
  });

  it("authenticates and gets a remote response", async () => {
    const identity = await createClientIdentity();
    const server = await startTestServer(identity, {
      getResponse: () => ({ status: "complete", response: "done", error: null }),
    });
    try {
      const client = createRemoteHubClient({
        identity,
        remote: {
          nodeId: "node_server",
          hubInstanceId: "hub_server",
          endpoint: server.url,
        },
        now: () => NOW,
        rejectUnauthorized: false,
      });

      await expect(client.getResponse("msg-1")).resolves.toEqual({
        status: "complete",
        response: "done",
        error: null,
      });
    } finally {
      server.stop();
    }
  });
});

async function startTestServer(
  identity: RemoteHubClientIdentity,
  options: {
    agents?: LocalAgent[];
    onSendPrompt?: (frame: SendPromptFrame) => Promise<{ ok: true; msgId: string; status: "delivered" } | { ok: false; error: string } | void>;
    getResponse?: (msgId: string) => { status: string; response?: unknown; error?: string | null };
  } = {}
) {
  const authorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(identity.publicKeyHex, "hex"))} client@example`
  );
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
        listAgents: () => options.agents ?? [],
        registerLocalAgent: (registration) => ({
          ...registration,
          status: "online",
          queueDepth: 0,
          contextUsedPct: 0,
          registeredAt: NOW,
          lastSeenAt: NOW,
        }),
        unregisterLocalAgent: () => false,
        onSendPrompt: options.onSendPrompt ?? (async () => undefined),
        getResponse: options.getResponse ?? (() => ({ status: "unknown", error: "message_not_found" })),
        submitResponse: () => ({ ok: false, error: "message_not_found" }),
      }),
  });
}

async function createClientIdentity(): Promise<RemoteHubClientIdentity> {
  const keyPair = await keygenAsync();
  return {
    nodeId: "node_client",
    hubInstanceId: "hub_client",
    endpoint: "wss://192.168.1.10:4444/v1/hub",
    publicKeyHex: Buffer.from(keyPair.publicKey).toString("hex"),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
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

async function generateSelfSignedTls(): Promise<{ tempDir: string; tls: TlsMaterial }> {
  const dir = await mkdtemp(join(tmpdir(), "coms-lan-remote-client-"));
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
