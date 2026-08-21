import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "amqplib";
import type { Channel } from "amqplib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  EXCHANGE_AGENTS,
  PROTOCOL_VERSION,
  agentQueueName,
  createEnvelope,
  fromAmqpMessage,
  toAmqpPublish,
  ulid,
  QUEUE_CORE_RPC,
  type AgentCard,
  type Envelope,
} from "@onclave/envelope";
import type { CoreConfig } from "../src/config";
import { startCore, type CoreRuntime } from "../src/service";

const amqpUrl = process.env.ONCLAVE_TEST_AMQP_URL ?? "";
const runId = ulid().toLowerCase();
const agentA = `agent-a-${runId}`;
const agentB = `agent-b-${runId}`;

type AmqpConnection = Awaited<ReturnType<typeof connect>>;

let dataDir: string;
let runtime: CoreRuntime;
let clientConnection: AmqpConnection;
let client: Channel;

function testConfig(dir: string): CoreConfig {
  return {
    amqpUrl,
    httpPort: 0,
    dataDir: dir,
    registryPath: join(dir, "registry.json"),
    conversationsPath: join(dir, "conversations.json"),
    auditPath: join(dir, "audit.jsonl"),
    trustDir: join(dir, "trust"),
    queueTtlMs: 60000,
    queueMaxLength: 100,
    heartbeatStaleMs: 5000,
    budgetLimits: { maxExchanges: 3, maxTotalTokens: 1000 },
    connectRetryBaseMs: 200,
    connectRetryMaxMs: 1000,
  };
}

async function waitFor<T>(
  probe: () => Promise<T | undefined>,
  label: string,
  timeoutMs = 15000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function rpcCall(request: object): Promise<Record<string, unknown>> {
  const replyQueue = await client.assertQueue("", { exclusive: true, autoDelete: true });
  const correlationId = ulid();
  const responsePromise = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("rpc timeout")), 10000);
    void client.consume(
      replyQueue.queue,
      (message) => {
        if (message === null || message.properties.correlationId !== correlationId) return;
        clearTimeout(timer);
        resolve(JSON.parse(message.content.toString("utf8")) as Record<string, unknown>);
      },
      { noAck: true }
    );
  });
  client.sendToQueue(QUEUE_CORE_RPC, Buffer.from(JSON.stringify(request), "utf8"), {
    correlationId,
    replyTo: replyQueue.queue,
  });
  return responsePromise;
}

function card(agentId: string, host = "test-host"): AgentCard {
  return { agent_id: agentId, name: agentId, host, transport: "amqp" };
}

async function popEnvelope(queue: string): Promise<Envelope> {
  return waitFor(async () => {
    const message = await client.get(queue, { noAck: true });
    if (message === false) return undefined;
    const parsed = fromAmqpMessage(message);
    if (!parsed.ok) throw new Error(`unparseable message on ${queue}: ${parsed.error}`);
    return parsed.envelope;
  }, `envelope on ${queue}`);
}

async function auditEvents(): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dataDir, "audit.jsonl"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.skipIf(amqpUrl === "")("core service integration", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "onclave-core-it-"));
    runtime = await startCore({ config: testConfig(dataDir), withHealthServer: false });
    await waitFor(
      async () => (runtime.broker.status().connected ? true : undefined),
      "core broker connection"
    );
    clientConnection = await connect(amqpUrl);
    client = await clientConnection.createChannel();
  }, 60000);

  afterAll(async () => {
    await clientConnection?.close();
    await runtime?.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  it("rejects registration with a mismatched protocol version", async () => {
    const response = await rpcCall({
      op: "register",
      protocol_version: PROTOCOL_VERSION + 1,
      card: card(agentA),
    });
    expect(response).toMatchObject({
      ok: false,
      error: "protocol_version_mismatch",
      expected: PROTOCOL_VERSION,
    });
  });

  it("registers agents, declares queues, and lists liveness", async () => {
    const first = await rpcCall({
      op: "register",
      protocol_version: PROTOCOL_VERSION,
      card: card(agentA),
    });
    expect(first).toMatchObject({ ok: true, queue: agentQueueName(agentA) });
    const second = await rpcCall({
      op: "register",
      protocol_version: PROTOCOL_VERSION,
      card: card(agentB, "other-host"),
    });
    expect(second).toMatchObject({ ok: true });

    const heartbeat = await rpcCall({ op: "heartbeat", agent_id: agentA });
    expect(heartbeat).toMatchObject({ ok: true });
    const unknown = await rpcCall({ op: "heartbeat", agent_id: "ghost" });
    expect(unknown).toMatchObject({ ok: false, error: "unknown_agent" });

    const list = await rpcCall({ op: "list_agents" });
    expect(list.ok).toBe(true);
    const agents = list.agents as Array<Record<string, unknown>>;
    const ids = agents.map((agent) => agent.agent_id);
    expect(ids).toContain(agentA);
    expect(ids).toContain(agentB);
  });

  it("routes envelopes to the registered agent queue", async () => {
    const envelope = createEnvelope({
      performative: "request",
      from: card(agentA),
      to: agentB,
      body: "integration hello",
    });
    const spec = toAmqpPublish(envelope);
    client.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
    const received = await popEnvelope(agentQueueName(agentB));
    expect(received).toEqual(envelope);
  });

  it("dead-letters expired messages and informs the originator", async () => {
    const envelope = createEnvelope({
      performative: "request",
      from: card(agentA),
      to: agentB,
      body: "this will expire",
      ttlMs: 300,
    });
    const spec = toAmqpPublish(envelope);
    client.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);

    const advisory = await popEnvelope(agentQueueName(agentA));
    expect(advisory.performative).toBe("inform");
    expect(advisory.conversation_id).toBe(envelope.conversation_id);
    expect(advisory.body).toContain(envelope.id);
    expect(advisory.body).toContain("expired");

    const events = await auditEvents();
    const received = events.find(
      (event) => event.event === "dead_letter_received" && event.message_id === envelope.id
    );
    expect(received).toMatchObject({ reason: "expired", to_agent_id: agentB });
    expect(
      events.find(
        (event) => event.event === "dead_letter_advisory_sent" && event.message_id === envelope.id
      )
    ).toBeDefined();
  }, 30000);

  it("terminates conversations at the exchange budget with failure to both parties", async () => {
    const conversationId = ulid();
    const record = (fromId: string, toId: string) =>
      rpcCall({
        op: "record_exchange",
        conversation_id: conversationId,
        message_id: ulid(),
        performative: "request",
        from_agent_id: fromId,
        to_agent_id: toId,
        usage: { input_tokens: 10, output_tokens: 5 },
      });

    expect(await record(agentA, agentB)).toMatchObject({ ok: true });
    expect(await record(agentB, agentA)).toMatchObject({ ok: true });
    const third = await record(agentA, agentB);
    expect(third).toMatchObject({ ok: false, error: "exchange_budget_exceeded" });

    const failureA = await popEnvelope(agentQueueName(agentA));
    const failureB = await popEnvelope(agentQueueName(agentB));
    for (const failure of [failureA, failureB]) {
      expect(failure.performative).toBe("failure");
      expect(failure.conversation_id).toBe(conversationId);
      expect(failure.body).toContain("exchange_budget_exceeded");
    }

    const status = await rpcCall({ op: "conversation_status", conversation_id: conversationId });
    expect(status).toMatchObject({ ok: true, state: { status: "terminated" } });

    const blocked = await record(agentA, agentB);
    expect(blocked).toMatchObject({ ok: false, error: "conversation_terminated" });

    const events = await auditEvents();
    expect(
      events.find(
        (event) =>
          event.event === "conversation_terminated" && event.conversation_id === conversationId
      )
    ).toBeDefined();
  }, 30000);

  it("keeps message bodies out of the audit log", async () => {
    const raw = await readFile(join(dataDir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain("integration hello");
    expect(raw).not.toContain("this will expire");
    for (const event of await auditEvents()) {
      expect(Object.keys(event)).not.toContain("body");
    }
  });

  it("cleans up: unregisters test agents", async () => {
    expect(await rpcCall({ op: "unregister", agent_id: agentA })).toMatchObject({ ok: true });
    expect(await rpcCall({ op: "unregister", agent_id: agentB })).toMatchObject({ ok: true });
    await client.deleteQueue(agentQueueName(agentA));
    await client.deleteQueue(agentQueueName(agentB));
  });
});
