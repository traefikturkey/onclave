import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import type { DiscoveryUdpSocket, UdpRemoteInfo } from "../../src/coms-lan/discovery";
import { signHandshakePayload, type HandshakePayload, type ServerHelloFrame } from "../../src/coms-lan/handshake";
import type { RemoteHubClient } from "../../src/coms-lan/remote-client";
import { ComsLanHubRuntime } from "../../src/coms-lan/hub-runtime";
import type { LocalAgent, LocalAgentRegistration } from "../../src/coms-lan/local-registry";
import type { ClientAuthFrame } from "../../src/coms-lan/transport";
import { sendAuthenticatedWssFrames, type TlsMaterial } from "../../src/coms-lan/wss-transport";

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

describe("ComsLanHubRuntime", () => {
  it("audits registration, message routing, and response submission", async () => {
    const events: Array<{ event: string; metadata: unknown }> = [];
    const delivered: unknown[] = [];
    const serverKeys = await createKeyMaterial();
    const runtime = new ComsLanHubRuntime({
      nodeId: "node_server",
      hubInstanceId: "hub_server",
      host: "127.0.0.1",
      tls,
      authorizedKeys: [],
      localPublicKeyHex: serverKeys.publicKeyHex,
      localPrivateKeyHex: serverKeys.privateKeyHex,
      discoverySocket: new FakeUdpSocket(),
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      startedAt: NOW,
      now: () => NOW,
      staleAfterMs: 30_000,
      offlineAfterMs: 60_000,
      deliverPrompt: async (prompt) => {
        delivered.push(prompt);
      },
      audit: (event, metadata) => {
        events.push({ event, metadata });
      },
    });

    const agent = runtime.registerLocalAgent(createRegistration());
    await runtime.routePrompt({
      type: "send_prompt",
      msgId: "msg-1",
      targetSessionId: agent.sessionId,
      prompt: "do not log me",
      hops: 0,
    });
    runtime.submitResponse({
      msgId: "msg-1",
      responderSessionId: agent.sessionId,
      response: "do not log me either",
      error: null,
      completedAt: NOW,
    });
    runtime.unregisterLocalAgent(agent.sessionId);

    expect(events).toEqual([
      { event: "local_register", metadata: { session_id: "session-1", name: "agent-one", project: "onclave@main" } },
      { event: "message_inbound", metadata: { msg_id: "msg-1", target_session_id: "session-1", hops: 0 } },
      { event: "message_outbound", metadata: { msg_id: "msg-1", target_session_id: "session-1", status: "delivered" } },
      { event: "response_inbound", metadata: { msg_id: "msg-1", responder_session_id: "session-1", error: null } },
      { event: "local_unregister", metadata: { session_id: "session-1", removed: true } },
    ]);
    expect(JSON.stringify(events)).not.toContain("do not log me");
    expect(delivered).toHaveLength(1);
  });

  it("lists trusted remote agents through remote clients", async () => {
    const remoteAgent = createAgent();
    const serverKeys = await createKeyMaterial();
    const runtime = new ComsLanHubRuntime({
      nodeId: "node_server",
      hubInstanceId: "hub_server",
      host: "127.0.0.1",
      tls,
      authorizedKeys: [],
      localPublicKeyHex: serverKeys.publicKeyHex,
      localPrivateKeyHex: serverKeys.privateKeyHex,
      discoverySocket: new FakeUdpSocket(),
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      startedAt: NOW,
      now: () => NOW,
      staleAfterMs: 30_000,
      offlineAfterMs: 60_000,
      remoteClientFactory: (peer) => {
        expect(peer.nodeId).toBe("node_remote");
        return {
          listAgents: async () => [remoteAgent],
        } as Pick<RemoteHubClient, "listAgents">;
      },
    });

    expect(
      await runtime.listTrustedRemoteAgents([
        {
          nodeId: "node_remote",
          hubInstanceId: "hub_remote",
          endpoint: "wss://192.168.1.20:4444/v1/hub",
          lastSeenAt: NOW,
          trustState: "trusted",
          authState: "not_attempted",
        },
        {
          nodeId: "node_untrusted",
          hubInstanceId: "hub_untrusted",
          endpoint: "wss://192.168.1.30:4444/v1/hub",
          lastSeenAt: NOW,
          trustState: "untrusted",
          authState: "not_attempted",
        },
      ])
    ).toEqual([{ peerNodeId: "node_remote", agent: remoteAgent }]);
  });

  it("starts WSS transport, broadcasts discovery, registers local agents, and gates remote listing", async () => {
    const discoverySocket = new FakeUdpSocket();
    const delivered: unknown[] = [];
    const auth = await createClientAuthFrame();
    const serverKeys = await createKeyMaterial();
    const runtime = new ComsLanHubRuntime({
      nodeId: "node_server",
      hubInstanceId: "hub_server",
      host: "0.0.0.0",
      tls,
      authorizedKeys: auth.authorizedKeys,
      localPublicKeyHex: serverKeys.publicKeyHex,
      localPrivateKeyHex: serverKeys.privateKeyHex,
      discoverySocket,
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      startedAt: NOW,
      now: () => NOW,
      staleAfterMs: 30_000,
      offlineAfterMs: 60_000,
      deliverPrompt: async (prompt) => {
        delivered.push(prompt);
      },
    });

    await runtime.start();
    try {
      const state = runtime.hubState();
      expect(state.endpoint).toBe(`https://127.0.0.1:${runtime.wssPort()}`);
      expect(discoverySocket.sent).toHaveLength(1);
      expect(JSON.parse(discoverySocket.sent[0]?.data.toString("utf8") ?? "{}")).toMatchObject({
        node_id: "node_server",
        hub_instance_id: "hub_server",
        wss_port: runtime.wssPort(),
      });

      const agent = runtime.registerLocalAgent(createRegistration());
      const responses = await sendAuthenticatedWssFrames(runtime.wssUrl(), {
        createAuthFrame: (hello) => createClientAuthFrameForHello(auth, hello),
        frames: [
          { type: "list_agents" },
          {
            type: "send_prompt",
            msgId: "msg-1",
            targetSessionId: "session-1",
            prompt: "hello",
            hops: 0,
          },
        ],
        rejectUnauthorized: false,
      });

      expect(responses[0]).toMatchObject({ type: "server_hello" });
      expect(responses[1]).toMatchObject({ type: "auth_ok" });
      expect(responses[2]).toEqual({ type: "agents", agents: [agent] });
      expect(responses[3]).toEqual({ type: "send_accepted", msgId: "msg-1", status: "delivered" });
      expect(delivered).toEqual([
        {
          msgId: "msg-1",
          targetSessionId: "session-1",
          deliveryEndpoint: "local://session-1",
          prompt: "hello",
          hops: 0,
          receivedAt: NOW,
        },
      ]);
    } finally {
      await runtime.stop();
    }

    expect(discoverySocket.closed).toBe(true);
  });
});

class FakeUdpSocket implements DiscoveryUdpSocket {
  boundPort: number | null = null;
  broadcastEnabled = false;
  closed = false;
  sent: Array<{ data: Buffer; port: number; address: string }> = [];

  async bind(port: number): Promise<void> {
    this.boundPort = port;
  }

  setBroadcast(enabled: boolean): void {
    this.broadcastEnabled = enabled;
  }

  onMessage(_handler: (data: Buffer, remote: UdpRemoteInfo) => void): void {}

  async send(data: Buffer, port: number, address: string): Promise<void> {
    this.sent.push({ data, port, address });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

async function generateSelfSignedTls(): Promise<{ tempDir: string; tls: TlsMaterial }> {
  const dir = await mkdtemp(join(tmpdir(), "coms-lan-runtime-"));
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
  publicKeyHex: string;
  privateKeyHex: string;
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>;
}> {
  const keyPair = await keygenAsync();
  return {
    publicKeyHex: Buffer.from(keyPair.publicKey).toString("hex"),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
    authorizedKeys: parseAuthorizedKeys(
      `ssh-ed25519 ${encodeOpenSshEd25519PublicKey(keyPair.publicKey)} test@example`
    ),
  };
}

async function createClientAuthFrameForHello(
  fixture: { publicKeyHex: string; privateKeyHex: string },
  hello: ServerHelloFrame
): Promise<ClientAuthFrame> {
  const payload: HandshakePayload = {
    protocol: "coms-lan",
    version: 1,
    client_node_id: "node_client",
    server_node_id: hello.hello.server_node_id,
    client_instance_id: "hub_client",
    server_instance_id: hello.hello.server_instance_id,
    client_endpoint: "wss://192.168.1.10:4444/v1/hub",
    server_endpoint: hello.hello.server_endpoint,
    client_nonce: "client-nonce",
    server_nonce: hello.hello.server_nonce,
    client_timestamp: NOW,
    server_timestamp: hello.hello.server_timestamp,
  };

  return {
    type: "client_auth",
    payload,
    publicKeyHex: fixture.publicKeyHex,
    signatureHex: await signHandshakePayload(payload, fixture.privateKeyHex),
  };
}

async function createKeyMaterial(): Promise<{ publicKeyHex: string; privateKeyHex: string }> {
  const keyPair = await keygenAsync();
  return {
    publicKeyHex: Buffer.from(keyPair.publicKey).toString("hex"),
    privateKeyHex: Buffer.from(keyPair.secretKey).toString("hex"),
  };
}

function createAgent(): LocalAgent {
  return {
    ...createRegistration(),
    status: "online",
    queueDepth: 0,
    contextUsedPct: 0,
    registeredAt: NOW,
    lastSeenAt: NOW,
  };
}

function createRegistration(): LocalAgentRegistration {
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
