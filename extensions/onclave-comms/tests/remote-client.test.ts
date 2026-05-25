import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../src/lib/authorized-keys";
import type { LocalAgent } from "../src/lib/local-registry";
import {
  createRemoteHubClient,
  RemoteHubAuthError,
  type RemoteHubClientIdentity,
} from "../src/lib/remote-client";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type SendPromptFrame,
} from "../src/lib/transport";
import { startWssHubServer, type TlsMaterial } from "../src/lib/wss-transport";

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
  it("authenticates and lists remote agents with mutual verification", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const serverIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const agent = createAgent();
    const server = await startTestServer(clientIdentity, serverIdentity, { agents: [agent] });
    try {
      const client = createRemoteHubClient({
        identity: clientIdentity,
        authorizedKeys: parseAuthorizedKeys(
          `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(serverIdentity.publicKeyHex, "hex"))} server@example`
        ),
        remote: {
          nodeId: serverIdentity.nodeId,
          hubInstanceId: serverIdentity.hubInstanceId,
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

  it("authenticates, sends a prompt to the remote hub, and audits metadata", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const serverIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const events: unknown[] = [];
    const sent: SendPromptFrame[] = [];
    const server = await startTestServer(clientIdentity, serverIdentity, {
      onSendPrompt: async (frame) => {
        sent.push(frame);
        return { ok: true, msgId: frame.msgId, status: "delivered" };
      },
    });
    try {
      const client = createRemoteHubClient({
        identity: clientIdentity,
        authorizedKeys: parseAuthorizedKeys(
          `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(serverIdentity.publicKeyHex, "hex"))} server@example`
        ),
        remote: {
          nodeId: serverIdentity.nodeId,
          hubInstanceId: serverIdentity.hubInstanceId,
          endpoint: server.url,
        },
        now: () => NOW,
        rejectUnauthorized: false,
        audit: (event, metadata) => {
          events.push({ event, metadata });
        },
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
      expect(events).toEqual([
        { event: "auth_attempt", metadata: { node_id: "node_server" } },
        { event: "auth_success", metadata: { node_id: "node_server", fingerprint: expect.any(String) } },
        { event: "message_outbound", metadata: { msg_id: "msg-1", target_session_id: "session-1", node_id: "node_server", status: "delivered" } },
      ]);
      expect(JSON.stringify(events)).not.toContain("hello");
    } finally {
      server.stop();
    }
  });

  it("rejects a remote auth response signed by an unknown server key", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const trustedServerIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const untrustedServerIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const server = await startTestServer(clientIdentity, untrustedServerIdentity, { agents: [] });
    try {
      const client = createRemoteHubClient({
        identity: clientIdentity,
        authorizedKeys: parseAuthorizedKeys(
          `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(trustedServerIdentity.publicKeyHex, "hex"))} server@example`
        ),
        remote: {
          nodeId: untrustedServerIdentity.nodeId,
          hubInstanceId: untrustedServerIdentity.hubInstanceId,
          endpoint: server.url,
        },
        now: () => NOW,
        rejectUnauthorized: false,
      });

      await expect(client.listAgents()).rejects.toBeInstanceOf(RemoteHubAuthError);
    } finally {
      server.stop();
    }
  });

  it("authenticates and gets a remote response", async () => {
    const clientIdentity = await createIdentity("node_client", "hub_client", "wss://192.168.1.10:4444/v1/hub");
    const serverIdentity = await createIdentity("node_server", "hub_server", "wss://127.0.0.1:0/v1/hub");
    const server = await startTestServer(clientIdentity, serverIdentity, {
      getResponse: () => ({ status: "complete", response: "done", error: null }),
    });
    try {
      const client = createRemoteHubClient({
        identity: clientIdentity,
        authorizedKeys: parseAuthorizedKeys(
          `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(serverIdentity.publicKeyHex, "hex"))} server@example`
        ),
        remote: {
          nodeId: serverIdentity.nodeId,
          hubInstanceId: serverIdentity.hubInstanceId,
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
  clientIdentity: RemoteHubClientIdentity,
  serverIdentity: RemoteHubClientIdentity,
  options: {
    agents?: LocalAgent[];
    onSendPrompt?: (frame: SendPromptFrame) => Promise<{ ok: true; msgId: string; status: "delivered" } | { ok: false; error: string } | void>;
    getResponse?: (msgId: string) => { status: string; response?: unknown; error?: string | null };
  } = {}
) {
  const authorizedKeys = parseAuthorizedKeys(
    `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(Buffer.from(clientIdentity.publicKeyHex, "hex"))} client@example`
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
          localIdentity: {
            nodeId: serverIdentity.nodeId,
            hubInstanceId: serverIdentity.hubInstanceId,
            endpoint: () => serverIdentity.endpoint,
            publicKeyHex: serverIdentity.publicKeyHex,
            privateKeyHex: serverIdentity.privateKeyHex,
          },
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
  const dir = await mkdtemp(join(tmpdir(), "onclave-remote-client-"));
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
