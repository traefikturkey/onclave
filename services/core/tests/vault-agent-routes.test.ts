import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Channel, ConsumeMessage } from "amqplib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentQueueName, createEnvelope, toAmqpPublish, type AgentCard, type Envelope } from "@onclave/envelope";
import { AgentDeliveryService } from "../src/agent-delivery";
import type { CoreConfig } from "../src/config";
import { ConversationStore } from "../src/conversations";
import { Registry } from "../src/registry";
import type { CoreServices } from "../src/rpc";
import { createAgentRouteHandlers } from "../src/vault/agent-routes";
import { createVaultHttpServer } from "../src/vault/http";
import { KeyStore, computeKeyId } from "../src/vault/keys";

const SSH_ED25519 = "ssh-ed25519";

type TestKey = {
  privateKey: KeyObject;
  keyId: string;
  authorizedKeysLine: string;
};

type Consumer = {
  queue: string;
  callback: (message: ConsumeMessage | null) => void;
};

class FakeChannel extends EventEmitter {
  readonly assertedQueues: Array<{ queue: string; options: Record<string, unknown> | undefined }> = [];
  readonly published: Array<{ exchange: string; routingKey: string }> = [];
  readonly nacked: Array<{ message: ConsumeMessage; requeue: boolean }> = [];
  private readonly consumers = new Map<string, Consumer>();
  private nextConsumer = 0;

  get consumerCount(): number {
    return this.consumers.size;
  }

  async assertQueue(queue: string, options?: Record<string, unknown>): Promise<{ queue: string }> {
    this.assertedQueues.push({ queue, options });
    return { queue };
  }

  async bindQueue(): Promise<void> {}

  publish(exchange: string, routingKey: string): boolean {
    this.published.push({ exchange, routingKey });
    return true;
  }

  async consume(queue: string, callback: (message: ConsumeMessage | null) => void): Promise<{ consumerTag: string }> {
    const consumerTag = `consumer-${this.nextConsumer}`;
    this.nextConsumer += 1;
    this.consumers.set(consumerTag, { queue, callback });
    return { consumerTag };
  }

  async cancel(consumerTag: string): Promise<void> {
    this.consumers.delete(consumerTag);
  }

  ack(): void {}

  nack(message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.nacked.push({ message, requeue });
  }

  enqueue(agentId: string, envelope: Envelope): void {
    const queue = agentQueueName(agentId);
    const consumer = [...this.consumers.values()].find((candidate) => candidate.queue === queue);
    if (consumer === undefined) throw new Error(`no consumer for ${queue}`);
    const spec = toAmqpPublish(envelope);
    consumer.callback({
      content: spec.content,
      fields: { consumerTag: queue },
      properties: spec.options,
    } as unknown as ConsumeMessage);
  }
}

function makeTestKey(comment: string): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublicKey = Buffer.from(publicKey.export({ format: "der", type: "spki" }).subarray(-32));
  const keyType = Buffer.from(SSH_ED25519, "utf8");
  const typeLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(keyType.length, 0);
  keyLength.writeUInt32BE(rawPublicKey.length, 0);
  const blob = Buffer.concat([typeLength, keyType, keyLength, rawPublicKey]);
  return {
    privateKey,
    keyId: computeKeyId(blob),
    authorizedKeysLine: `${SSH_ED25519} ${blob.toString("base64")} ${comment}`,
  };
}

function signRequest(key: TestKey, method: string, path: string, host: string, body?: Buffer): Record<string, string> {
  const components = ['"@method"', '"@path"', '"@authority"'];
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${host}`];
  let contentDigest: string | undefined;
  if (body !== undefined) {
    components.push('"content-digest"');
    contentDigest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    lines.push(`"content-digest": ${contentDigest}`);
  }
  const params = `(${components.join(" ")});keyid="${key.keyId}";alg="ed25519";created=${Math.floor(Date.now() / 1000)}`;
  lines.push(`"@signature-params": ${params}`);
  const signature = cryptoSign(null, Buffer.from(lines.join("\n"), "utf8"), key.privateKey).toString("base64");
  return {
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature}:`,
    ...(contentDigest === undefined ? {} : { "content-digest": contentDigest }),
  };
}

function config(dataDir: string): CoreConfig {
  return {
    amqpUrl: "amqp://test",
    httpPort: 0,
    dataDir,
    registryPath: join(dataDir, "registry.json"),
    conversationsPath: join(dataDir, "conversations.json"),
    auditPath: join(dataDir, "audit.jsonl"),
    trustDir: join(dataDir, "trust"),
    queueTtlMs: 60_000,
    queueMaxLength: 100,
    heartbeatStaleMs: 5_000,
    budgetLimits: { maxExchanges: 3, maxTotalTokens: 1_000 },
    connectRetryBaseMs: 100,
    connectRetryMaxMs: 1_000,
  };
}

function card(agentId: string, fields: Partial<AgentCard> = {}): AgentCard {
  return { agent_id: agentId, name: "Agent", host: "test-host", transport: "amqp", ...fields };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind");
  return (address as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
}

async function waitForConsumer(channel: FakeChannel): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (channel.consumerCount > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("long poll consumer was not created");
}

describe("signed agent vault routes", () => {
  let keyA: TestKey;
  let keyB: TestKey;
  let keyC: TestKey;
  let dataDir: string;
  let server: Server;
  let baseUrl: string;
  let channel: FakeChannel;
  let deliveries: AgentDeliveryService;
  let registry: Registry;

  beforeEach(async () => {
    keyA = makeTestKey("agent-a@example");
    keyB = makeTestKey("agent-b@example");
    keyC = makeTestKey("untrusted@example");
    dataDir = mkdtempSync(join(tmpdir(), "vault-agent-routes-"));
    const keysPath = join(dataDir, "authorized_keys");
    writeFileSync(keysPath, `${keyA.authorizedKeysLine}\n${keyB.authorizedKeysLine}\n`, "utf8");
    const coreConfig = config(dataDir);
    registry = new Registry({ path: coreConfig.registryPath, staleMs: coreConfig.heartbeatStaleMs });
    const services: CoreServices = {
      config: coreConfig,
      registry,
      conversations: new ConversationStore({ path: coreConfig.conversationsPath, limits: coreConfig.budgetLimits }),
      audit: async (): Promise<void> => {},
    };
    channel = new FakeChannel();
    deliveries = new AgentDeliveryService({ leaseMs: 1_000 });
    deliveries.onChannelReady(channel as unknown as Channel);
    server = createVaultHttpServer({
      keyStore: new KeyStore(keysPath),
      handlers: createAgentRouteHandlers({
        services,
        channel: () => channel as unknown as Channel,
        deliveries,
      }),
    });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    deliveries.close();
    await close(server);
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function request(key: TestKey, path: string, method = "GET", body?: unknown): Promise<Response> {
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: signRequest(key, method, path, new URL(baseUrl).host, bytes),
      body: bytes,
    });
  }

  async function register(agentId = "agent-a", key = keyA, fields: Partial<AgentCard> = {}): Promise<Response> {
    return request(key, "/api/v1/agents/rpc", "POST", {
      op: "register",
      protocol_version: 1,
      card: card(agentId, fields),
    });
  }

  async function registerOk(agentId = "agent-a", key = keyA, fields: Partial<AgentCard> = {}): Promise<void> {
    expect((await register(agentId, key, fields)).status).toBe(200);
  }

  it("rejects unsigned agent routes and binds heartbeat and unregister to the registration key", async () => {
    expect((await fetch(`${baseUrl}/api/v1/agents/rpc`, { method: "POST", body: "{}" })).status).toBe(401);
    const unknownKey = await request(keyC, "/api/v1/agents/rpc", "POST", { op: "list_agents" });
    expect(unknownKey.status).toBe(401);
    await registerOk();
    expect(channel.assertedQueues).toContainEqual(expect.objectContaining({
      queue: agentQueueName("agent-a"),
      options: expect.objectContaining({
        arguments: expect.objectContaining({ "x-dead-letter-exchange": "onclave.dlx" }),
      }),
    }));

    const wrongHeartbeat = await request(keyB, "/api/v1/agents/rpc", "POST", { op: "heartbeat", agent_id: "agent-a" });
    expect(wrongHeartbeat.status).toBe(403);
    const wrongUnregister = await request(keyB, "/api/v1/agents/rpc", "POST", { op: "unregister", agent_id: "agent-a" });
    expect(wrongUnregister.status).toBe(403);
    const heartbeat = await request(keyA, "/api/v1/agents/rpc", "POST", { op: "heartbeat", agent_id: "agent-a" });
    await expect(heartbeat.json()).resolves.toEqual({ ok: true });
  });

  it("publishes only registered origins and leases deliveries to the registered key", async () => {
    const agentFields = { name: "Agent A", host: "agent-a-host", project: "project-a" };
    await registerOk("agent-a", keyA, agentFields);
    const outbound = createEnvelope({
      performative: "inform",
      from: card("agent-a", agentFields),
      to: "agent-a",
      body: "outbound",
    });
    const publish = await request(keyA, "/api/v1/agents/messages", "POST", outbound);
    expect(publish.status).toBe(202);
    await expect(publish.json()).resolves.toEqual({ ok: true, message_id: outbound.id });
    expect(channel.published).toContainEqual({ exchange: "onclave.agents", routingKey: "agent-a" });

    const unknownOrigin = createEnvelope({ performative: "inform", from: card("unknown"), to: "agent-a", body: "forged" });
    expect((await request(keyA, "/api/v1/agents/messages", "POST", unknownOrigin)).status).toBe(404);
    const alteredOrigin = createEnvelope({
      performative: "inform",
      from: card("agent-a", { ...agentFields, host: "forged-host" }),
      to: "agent-a",
      body: "forged",
    });
    expect((await request(keyA, "/api/v1/agents/messages", "POST", alteredOrigin)).status).toBe(403);
    await registerOk("agent-b", keyB);
    const wrongKeyOrigin = createEnvelope({ performative: "inform", from: card("agent-b"), to: "agent-a", body: "forged" });
    expect((await request(keyA, "/api/v1/agents/messages", "POST", wrongKeyOrigin)).status).toBe(403);
    const invalidPublish = await request(keyA, "/api/v1/agents/messages", "POST", {});
    expect(invalidPublish.status).toBe(422);

    const wrongPoll = await request(keyB, "/api/v1/agents/messages/next?agent_id=agent-a&wait_ms=0");
    expect(wrongPoll.status).toBe(403);
    const emptyPoll = await request(keyA, "/api/v1/agents/messages/next?agent_id=agent-a&wait_ms=0");
    expect(emptyPoll.status).toBe(204);

    const nextPath = "/api/v1/agents/messages/next?agent_id=agent-a&wait_ms=100";
    const pending = request(keyA, nextPath);
    await waitForConsumer(channel);
    const inbound = createEnvelope({ performative: "request", from: card("sender"), to: "agent-a", body: "inbound" });
    channel.enqueue("agent-a", inbound);
    const next = await pending;
    expect(next.status).toBe(200);
    const payload = await next.json() as { delivery_id: string; envelope: Envelope };
    expect(payload.envelope).toEqual(inbound);

    const dispositionPath = `/api/v1/agents/messages/${payload.delivery_id}`;
    const wrongDisposition = await request(keyB, dispositionPath, "POST", { disposition: "reject" });
    expect(wrongDisposition.status).toBe(403);
    const reject = await request(keyA, dispositionPath, "POST", { disposition: "reject" });
    await expect(reject.json()).resolves.toEqual({ ok: true });
    expect(channel.nacked).toContainEqual({ message: expect.anything(), requeue: false });
  });

  it("allows either registered exchange participant to record an exchange", async () => {
    await registerOk("agent-a", keyA);
    await registerOk("agent-b", keyB);
    const exchange = createEnvelope({ performative: "inform", from: card("agent-a"), to: "agent-b", body: "recorded" });
    const record = {
      op: "record_exchange",
      conversation_id: exchange.conversation_id,
      message_id: exchange.id,
      performative: exchange.performative,
      from_agent_id: "agent-a",
      to_agent_id: "agent-b",
    };

    expect((await request(keyA, "/api/v1/agents/rpc", "POST", record)).status).toBe(200);
    expect((await request(keyB, "/api/v1/agents/rpc", "POST", record)).status).toBe(200);
    expect((await request(keyB, "/api/v1/agents/rpc", "POST", {
      ...record,
      to_agent_id: "agent-a",
    })).status).toBe(403);
  });

  it("prevents concurrent key takeover and permits operator-key reuse", async () => {
    const registrations = await Promise.all([
      register("agent-a", keyA),
      register("agent-a", keyB),
    ]);
    expect(registrations.map((response) => response.status).sort()).toEqual([200, 403]);

    const boundKey = registry.get("agent-a")?.key_id;
    expect([keyA.keyId, keyB.keyId]).toContain(boundKey);
    const winningKey = boundKey === keyA.keyId ? keyA : keyB;
    expect((await register("agent-a", winningKey, { name: "Agent A2" })).status).toBe(200);
    expect((await register("agent-b", winningKey)).status).toBe(200);
    expect(registry.get("agent-a")).toMatchObject({ key_id: winningKey.keyId, name: "Agent A2" });
    expect(registry.get("agent-b")).toMatchObject({ key_id: winningKey.keyId });

    const reloaded = new Registry({ path: join(dataDir, "registry.json"), staleMs: 5_000 });
    await reloaded.load();
    expect(reloaded.get("agent-a")).toMatchObject({ key_id: winningKey.keyId, name: "Agent A2" });
  });
});
