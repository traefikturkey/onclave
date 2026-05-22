import { describe, expect, it } from "bun:test";
import { keygenAsync } from "@noble/ed25519";
import { parseAuthorizedKeys } from "../../src/coms-lan/authorized-keys";
import { signHandshakePayload, type HandshakePayload } from "../../src/coms-lan/handshake";
import {
  HubFrameProcessor,
  HubTransportAuthGate,
  type ClientAuthFrame,
  type SendPromptFrame,
} from "../../src/coms-lan/transport";
import type { LocalAgent, LocalAgentRegistration } from "../../src/coms-lan/local-registry";

const NOW = "2026-05-21T00:00:00.000Z";

describe("HubFrameProcessor", () => {
  it("rejects malformed frames without throwing", async () => {
    const processor = createProcessor([]);

    await expect(processor.handleRaw("not json")).resolves.toEqual({
      type: "error",
      code: "invalid_frame",
    });
  });

  it("registers local agents without hub-to-hub authentication", async () => {
    const registered: LocalAgentRegistration[] = [];
    const agent = createAgent();
    const processor = createProcessor([], {
      registerLocalAgent: (registration) => {
        registered.push(registration);
        return agent;
      },
    });

    await expect(
      processor.handleRaw(JSON.stringify({ type: "local_register", registration: createRegistration() }))
    ).resolves.toEqual({ type: "local_register_ok", agent });
    expect(registered).toEqual([createRegistration()]);
  });

  it("unregisters local agents without hub-to-hub authentication", async () => {
    const unregistered: string[] = [];
    const processor = createProcessor([], {
      unregisterLocalAgent: (sessionId) => {
        unregistered.push(sessionId);
        return true;
      },
    });

    await expect(
      processor.handleRaw(JSON.stringify({ type: "local_unregister", sessionId: "session-1" }))
    ).resolves.toEqual({ type: "local_unregister_ok", sessionId: "session-1", removed: true });
    expect(unregistered).toEqual(["session-1"]);
  });

  it("requires authentication before listing agents", async () => {
    const processor = createProcessor([]);

    await expect(processor.handleRaw(JSON.stringify({ type: "list_agents" }))).resolves.toEqual({
      type: "error",
      code: "auth_required",
    });
  });

  it("authenticates a client auth frame", async () => {
    const fixture = await createClientAuthFrame();
    const processor = createProcessor(fixture.authorizedKeys);

    const response = await processor.handleRaw(JSON.stringify(fixture.frame));

    expect(response).toMatchObject({
      type: "auth_ok",
      peer: {
        nodeId: "node_client",
        hubInstanceId: "hub_client",
        endpoint: "wss://192.168.1.10:4444/v1/hub",
      },
    });
  });

  it("lists agents only after authentication", async () => {
    const fixture = await createClientAuthFrame();
    const agent = createAgent();
    const processor = createProcessor(fixture.authorizedKeys, { agents: [agent] });

    await processor.handleRaw(JSON.stringify(fixture.frame));
    const response = await processor.handleRaw(JSON.stringify({ type: "list_agents" }));

    expect(response).toEqual({
      type: "agents",
      agents: [agent],
    });
  });

  it("requires authentication before accepting prompt sends", async () => {
    const sent: SendPromptFrame[] = [];
    const processor = createProcessor([], {
      onSendPrompt: async (frame) => {
        sent.push(frame);
      },
    });
    const frame: SendPromptFrame = {
      type: "send_prompt",
      msgId: "msg-1",
      targetSessionId: "session-1",
      prompt: "hello",
      hops: 0,
    };

    const response = await processor.handleRaw(JSON.stringify(frame));

    expect(response).toEqual({ type: "error", code: "auth_required" });
    expect(sent).toEqual([]);
  });

  it("accepts prompt sends after authentication", async () => {
    const fixture = await createClientAuthFrame();
    const sent: SendPromptFrame[] = [];
    const processor = createProcessor(fixture.authorizedKeys, {
      onSendPrompt: async (frame) => {
        sent.push(frame);
        return { ok: true, msgId: frame.msgId, status: "delivered" };
      },
    });
    const frame: SendPromptFrame = {
      type: "send_prompt",
      msgId: "msg-1",
      targetSessionId: "session-1",
      prompt: "hello",
      hops: 0,
    };

    await processor.handleRaw(JSON.stringify(fixture.frame));
    const response = await processor.handleRaw(JSON.stringify(frame));

    expect(response).toEqual({ type: "send_accepted", msgId: "msg-1", status: "delivered" });
    expect(sent).toEqual([frame]);
  });

  it("returns routing failures for authenticated prompt sends", async () => {
    const fixture = await createClientAuthFrame();
    const processor = createProcessor(fixture.authorizedKeys, {
      onSendPrompt: async () => ({ ok: false, error: "target_not_found" }),
    });

    await processor.handleRaw(JSON.stringify(fixture.frame));
    const response = await processor.handleRaw(
      JSON.stringify({
        type: "send_prompt",
        msgId: "msg-1",
        targetSessionId: "missing",
        prompt: "hello",
        hops: 0,
      })
    );

    expect(response).toEqual({ type: "send_rejected", msgId: "msg-1", error: "target_not_found" });
  });
});

function createProcessor(
  authorizedKeys: ReturnType<typeof parseAuthorizedKeys>,
  options: {
    agents?: LocalAgent[];
    registerLocalAgent?: (registration: LocalAgentRegistration) => LocalAgent;
    unregisterLocalAgent?: (sessionId: string) => boolean;
    onSendPrompt?: (frame: SendPromptFrame) => Promise<{ ok: true; msgId: string; status: "delivered" } | { ok: false; error: string } | void>;
  } = {}
): HubFrameProcessor {
  return new HubFrameProcessor({
    gate: new HubTransportAuthGate({
      authorizedKeys,
      now: () => new Date(NOW),
      maxSkewMs: 30_000,
    }),
    listAgents: () => options.agents ?? [],
    registerLocalAgent: options.registerLocalAgent ?? ((registration) => ({ ...registration, status: "online", queueDepth: 0, contextUsedPct: 0, registeredAt: NOW, lastSeenAt: NOW })),
    unregisterLocalAgent: options.unregisterLocalAgent ?? (() => false),
    onSendPrompt: options.onSendPrompt ?? (async () => undefined),
  });
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
