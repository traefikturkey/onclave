import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect, type Channel, type ChannelModel } from "amqplib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  A2A_PROTOCOL_VERSION,
  EXCHANGE_AGENTS,
  QUEUE_CORE_RPC,
  agentQueueName,
  createMessage,
  toA2AMessagePublish,
  ulid,
  type AgentCard,
  type Message,
  type RpcRequest,
  type TaskStatusEvent,
} from "@onclave/envelope";
import { CorrelationStore } from "../../../extensions/onclave-pi/src/lib/correlation";
import { handleInbound, type Delivered } from "../../../extensions/onclave-pi/src/lib/delivery";
import { SeenIds } from "../../../extensions/onclave-pi/src/lib/dedup";
import { AgentDeliveryService } from "../src/agent-delivery";
import { handleRpcRequest, startRpcServer } from "../src/rpc";
import { Registry } from "../src/registry";
import { TaskStore } from "../src/tasks";
import type { CoreConfig } from "../src/config";

const amqpUrl = process.env.ONCLAVE_TEST_AMQP_URL ?? "";
const describeIntegration = amqpUrl === "" ? describe.skip : describe;

type HarnessOptions = { id: string; host: string };
type Turn = { message: Message; trigger: boolean };

type CoreFixture = {
  connection: ChannelModel;
  channel: Channel;
  services: { config: CoreConfig; registry: Registry; tasks: TaskStore; audit: () => Promise<void> };
  dir: string;
};

const config = (dir: string): CoreConfig => ({
  amqpUrl,
  httpPort: 0,
  dataDir: dir,
  registryPath: join(dir, "registry.json"),
  a2aStatePath: join(dir, "a2a-state-v1.json"),
  auditPath: join(dir, "audit.jsonl"),
  trustDir: join(dir, "trust"),
  queueTtlMs: 60_000,
  queueMaxLength: 1000,
  heartbeatStaleMs: 60_000,
  budgetLimits: { maxExchanges: 16, maxTotalTokens: 5 },
  connectRetryBaseMs: 10,
  connectRetryMaxMs: 50,
});

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for broker delivery");
}

async function startCoreFixture(): Promise<CoreFixture> {
  const dir = await mkdtemp(join(tmpdir(), "onclave-t3-core-"));
  const connection = await connect(amqpUrl);
  const channel = await connection.createChannel();
  await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
  await channel.assertQueue(QUEUE_CORE_RPC, { durable: true });
  const services = {
    config: config(dir),
    registry: new Registry({ path: join(dir, "registry.json"), staleMs: 60_000 }),
    tasks: new TaskStore({ path: join(dir, "a2a-state-v1.json"), limits: { maxTotalTokens: 5 } }),
    audit: async () => undefined,
  };
  await startRpcServer(services, channel);
  return { connection, channel, services, dir };
}

class PiHarness {
  readonly card: AgentCard;
  readonly connectionPromise: Promise<ChannelModel>;
  readonly channelPromise: Promise<Channel>;
  readonly rpcChannelPromise: Promise<Channel>;
  readonly delivery = new AgentDeliveryService();
  readonly correlation = new CorrelationStore();
  readonly seen = new SeenIds();
  readonly turns: Turn[] = [];
  readonly inert: Message[] = [];
  readonly statuses: TaskStatusEvent[] = [];
  private rpcQueue: string | undefined;
  private rpcConsumerStarted = false;
  private readonly rpcWaiters = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: unknown) => void }>();

  constructor(options: HarnessOptions) {
    this.card = { agent_id: options.id, name: options.id, host: options.host, transport: "amqp" };
    this.connectionPromise = connect(amqpUrl);
    this.channelPromise = this.connectionPromise.then(async (connection) => {
      const channel = await connection.createChannel();
      await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
      this.delivery.onChannelReady(channel);
      return channel;
    });
    this.rpcChannelPromise = this.connectionPromise.then((connection) => connection.createChannel());
  }

  async register(protocolVersion = A2A_PROTOCOL_VERSION): Promise<Record<string, unknown>> {
    const response = await this.rpc({ op: "register", protocol_version: protocolVersion, card: this.card });
    if (protocolVersion === A2A_PROTOCOL_VERSION) expect(response.ok).toBe(true);
    return response;
  }

  async rpc(request: RpcRequest): Promise<Record<string, unknown>> {
    const channel = await this.rpcChannelPromise;
    if (this.rpcQueue === undefined) {
      this.rpcQueue = `onclave.t3.rpc.${this.card.agent_id}.${ulid().toLowerCase()}`;
      await channel.assertQueue(this.rpcQueue, { durable: true, autoDelete: false });
    }
    if (!this.rpcConsumerStarted) {
      await channel.consume(this.rpcQueue, (message) => {
        if (message === null) return;
        const waiter = this.rpcWaiters.get(message.properties.correlationId ?? "");
        if (waiter === undefined) return;
        this.rpcWaiters.delete(message.properties.correlationId ?? "");
        channel.ack(message);
        try { waiter.resolve(JSON.parse(message.content.toString("utf8")) as Record<string, unknown>); } catch (error) { waiter.reject(error); }
      });
      this.rpcConsumerStarted = true;
    }
    const correlationId = ulid();
    const response = new Promise<Record<string, unknown>>((resolve, reject) => this.rpcWaiters.set(correlationId, { resolve, reject }));
    channel.sendToQueue(QUEUE_CORE_RPC, Buffer.from(JSON.stringify(request), "utf8"), { correlationId, replyTo: this.rpcQueue, contentType: "application/json" });
    return response;
  }

  async publish(message: Message): Promise<void> {
    const channel = await this.channelPromise;
    const spec = toA2AMessagePublish(message);
    channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
  }

  async receive(_legacyConfirm = true): Promise<Delivered> {
    const delivery = await this.delivery.next(this.card.agent_id, "test-key", 5000);
    if (delivery === undefined) throw new Error(`no delivery for ${this.card.agent_id}`);
    const item: Delivered = delivery.kind === "message" ? { kind: "message", message: delivery.message as Message } : { kind: "task-status", status: delivery.status as TaskStatusEvent };
    const decision = await handleInbound({
      seen: this.seen,
      correlation: this.correlation,
      createTask: async (message) => {
        if (message.type === "inform") return message;
        const created = await this.rpc({ op: "create_task", context_id: message.context_id, origin_instance_id: message.origin.instance_id, assignee_instance_id: this.card.agent_id, ...(message.task_id === undefined ? {} : { task_id: message.task_id }) });
        if (created.ok !== true || created.task === undefined) throw new Error(String(created.error ?? "task creation failed"));
        const task = created.task as { task_id: string; state: string; context_id: string };
        if (message.task_id !== undefined && task.state !== "submitted" && task.state !== "working" && task.state !== "input-required") {
          const followUp = await this.rpc({ op: "create_task", context_id: message.context_id, origin_instance_id: message.origin.instance_id, assignee_instance_id: this.card.agent_id, prior_task_id: message.task_id });
          if (followUp.ok !== true || followUp.task === undefined) throw new Error(String(followUp.error ?? "follow-up task failed"));
          return { ...message, task_id: (followUp.task as { task_id: string }).task_id };
        }
        return { ...message, task_id: task.task_id };
      },
      markWorking: async (message) => {
        if (message.task_id === undefined) return;
        const updated = await this.rpc({ op: "update_task", task_id: message.task_id, state: "working", destination: message.origin.instance_id, message_id: message.message_id });
        if (updated.ok !== true && updated.error !== "illegal_transition") throw new Error(String(updated.error));
      },
      deliverTurn: (message) => this.turns.push({ message, trigger: true }),
      deliverInert: (message) => this.inert.push(message),
      deliverStatus: (status) => this.statuses.push(status),
      registerInbound: (message) => this.correlation.registerInbound(message),
      audit: async () => undefined,
    }, item);
    this.delivery.dispose(delivery.deliveryId, "test-key", decision);
    return item;
  }

  async close(): Promise<void> {
    this.delivery.close();
    const channel = await this.rpcChannelPromise;
    await channel.deleteQueue(this.rpcQueue ?? "").catch(() => undefined);
    await (await this.connectionPromise).close();
  }
}

async function message(type: Message["type"], origin: PiHarness, destination: string, contextId = ulid(), taskId?: string): Promise<Message> {
  return createMessage({ type, context_id: contextId, origin: { instance_id: origin.card.agent_id, name: origin.card.name, host: origin.card.host }, destination, body: `${type} body`, ...(taskId === undefined ? {} : { task_id: taskId }) });
}

describeIntegration("T3 integrated A2A protocol proof", () => {
  let core: CoreFixture;
  let harnesses: PiHarness[] = [];

  beforeAll(async () => { core = await startCoreFixture(); });
  beforeEach(async () => {
    await core.channel.deleteQueue(agentQueueName("pi-a")).catch(() => undefined);
    await core.channel.deleteQueue(agentQueueName("pi-b")).catch(() => undefined);
  });
  afterEach(async () => { await Promise.all(harnesses.map((harness) => harness.close())); harnesses = []; });
  afterEach(async () => { await core.services.registry.unregister("pi-a").catch(() => undefined); await core.services.registry.unregister("pi-b").catch(() => undefined); });
  afterAll(async () => { await core.connection.close(); await rm(core.dir, { recursive: true, force: true }); });

  it("proves ask, request, inert inform, trusted delivery, and duplicate-safe origin events", async () => {
    const a = new PiHarness({ id: "pi-a", host: "host-a" });
    const b = new PiHarness({ id: "pi-b", host: "host-b" });
    harnesses = [a, b];
    await a.register();
    await b.register();

    const ask = await message("ask", a, b.card.agent_id);
    a.correlation.registerOutbound(ask);
    await a.publish(ask);
    const askDelivery = await b.receive(true);
    expect(askDelivery).toMatchObject({ kind: "message", message: { type: "ask" } });
    const askTask = b.turns.at(-1)?.message.task_id as string;
    const completed = await b.rpc({ op: "update_task", task_id: askTask, state: "completed", destination: a.card.agent_id, message_id: ask.message_id, body: "answer" });
    expect(completed.ok).toBe(true);
    const reply = createMessage({ type: "inform", context_id: ask.context_id, origin: { instance_id: b.card.agent_id, name: b.card.name, host: b.card.host }, destination: a.card.agent_id, body: "answer" });
    await b.publish(reply);
    await a.receive(true);
    await a.receive(true);
    await a.receive(true);
    await a.receive(true);
    expect((await a.correlation.waitFor(ask, 100))?.body).toBe("answer");
    expect(a.inert).toHaveLength(1);

    const request = await message("request", a, b.card.agent_id);
    a.correlation.registerOutbound(request);
    await a.publish(request);
    const requestDelivery = await b.receive(true);
    const requestTask = b.turns.at(-1)?.message.task_id as string;
    expect(requestTask).toBeDefined();
    const submitted = await a.receive(true);
    expect((submitted as { status: TaskStatusEvent }).status.state).toBe("submitted");

    const inform = await message("inform", a, b.card.agent_id);
    await a.publish(inform);
    await b.receive(true);
    expect(b.turns).toHaveLength(2);
    expect(b.inert.at(-1)?.body).toBe("inform body");

    const duplicate = await b.rpc({ op: "update_task", task_id: requestTask, state: "completed", destination: a.card.agent_id, message_id: request.message_id, body: "done" });
    const duplicateRetry = await b.rpc({ op: "update_task", task_id: requestTask, state: "completed", destination: a.card.agent_id, message_id: request.message_id, body: "done" });
    expect(duplicate.ok).toBe(true);
    expect(duplicateRetry).toMatchObject({ ok: true, duplicate: true });
    await a.receive(true);
    await a.receive(true);
    await a.receive(true);
    expect(a.statuses.filter((event) => event.task_id === requestTask && event.state === "completed")).toHaveLength(1);
  });

  it("proves input-required resumption and terminal refinement in one context", async () => {
    const a = new PiHarness({ id: "pi-a", host: "host-a" });
    const b = new PiHarness({ id: "pi-b", host: "host-a" });
    harnesses = [a, b];
    await a.register();
    await b.register();
    const contextId = ulid();
    const initial = await message("request", a, b.card.agent_id, contextId);
    a.correlation.registerOutbound(initial);
    await a.publish(initial);
    const received = await b.receive();
    const taskId = b.turns.at(-1)?.message.task_id as string;
    await b.rpc({ op: "update_task", task_id: taskId, state: "input-required", destination: a.card.agent_id, body: "need input" });
    await a.receive();
    await a.receive();
    await a.receive();
    expect(a.statuses.at(-1)?.state).toBe("input-required");

    const continuation = await message("request", a, b.card.agent_id, contextId, taskId);
    await a.publish(continuation);
    const resumed = await b.receive();
    expect((resumed as { message: Message }).message.task_id).toBe(taskId);
    await b.rpc({ op: "update_task", task_id: taskId, state: "completed", destination: a.card.agent_id });
    await a.receive();

    const refinement = await message("request", a, b.card.agent_id, contextId, taskId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await a.publish(refinement);
    const refined = await b.receive();
    const refinedTaskId = b.turns.at(-1)?.message.task_id as string;
    expect(refinedTaskId).not.toBe(taskId);
    const refinedTask = await b.rpc({ op: "get_task", task_id: refinedTaskId });
    expect(refinedTask).toMatchObject({ ok: true, task: { context_id: contextId, prior_task_id: taskId, state: "working" } });
    expect((await b.rpc({ op: "get_task", task_id: taskId })).task).toMatchObject({ state: "completed" });
  });

  it("proves budget termination, version rejection, and reconnect delivery", async () => {
    const a = new PiHarness({ id: "pi-a", host: "host-a" });
    const b = new PiHarness({ id: "pi-b", host: "host-a" });
    harnesses = [a, b];
    await a.register();
    await b.register();
    const badVersion = new PiHarness({ id: "bad-version", host: "host-a" });
    harnesses.push(badVersion);
    await expect(badVersion.register(2)).resolves.toMatchObject({ ok: false, error: "protocol_version_mismatch" });

    const budget = await message("request", a, b.card.agent_id);
    await a.publish(budget);
    const budgetDelivery = await b.receive();
    const budgetTask = b.turns.at(-1)?.message.task_id as string;
    const budgetResult = await b.rpc({ op: "update_task", task_id: budgetTask, state: "input-required", usage: { input_tokens: 3, output_tokens: 2 } });
    expect(budgetResult).toEqual({ ok: false, error: "budget_exceeded" });
    expect((await b.rpc({ op: "get_task", task_id: budgetTask })).task).toMatchObject({ state: "working" });
    await a.receive();
    await a.receive();

    await a.close();
    const retained = await message("inform", b, a.card.agent_id);
    await b.publish(retained);
    const reconnected = new PiHarness({ id: "pi-a", host: "host-a" });
    harnesses = [b, reconnected];
    await reconnected.register();
    await reconnected.receive();
    expect(reconnected.inert.map((item) => item.message_id)).toContain(retained.message_id);
  });
});
