import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { connect } from "amqplib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EXCHANGE_AGENTS,
  agentQueueName,
  createMessage,
  createTask,
  createTaskStatusEvent,
  toA2AMessagePublish,
  toA2ATaskStatusPublish,
  ulid,
  type Message,
  type Task,
} from "@onclave/envelope";
import { AgentDeliveryService } from "../src/agent-delivery";
import { TaskStore } from "../src/tasks";

const amqpUrl = process.env.ONCLAVE_TEST_AMQP_URL ?? "";
const receiver = `a2a-delivery-${ulid().toLowerCase()}`;
const origin = { instance_id: `origin-${ulid().toLowerCase()}`, name: "Origin", host: "test-host" };

function message(type: Message["type"] = "request"): Message {
  return createMessage({
    context_id: ulid(),
    type,
    origin,
    destination: receiver,
    body: "retained message",
  });
}

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for broker delivery");
}

describe.skipIf(amqpUrl === "")("A2A broker-backed delivery retention", () => {
  let connection: Awaited<ReturnType<typeof connect>>;
  let channel: Awaited<ReturnType<typeof connection.createChannel>>;
  let queue: string;
  let statusQueue: string | undefined;

  beforeEach(async () => {
    connection = await connect(amqpUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
    queue = agentQueueName(receiver);
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EXCHANGE_AGENTS, receiver);
  });

  afterEach(async () => {
    if (statusQueue !== undefined) await channel.deleteQueue(statusQueue).catch(() => undefined);
    await channel.deleteQueue(queue).catch(() => undefined);
    await connection.close().catch(() => undefined);
    statusQueue = undefined;
  });

  it("retains an unacknowledged message across consumer restart and disconnect/reconnect", async () => {
    const item = message();
    const spec = toA2AMessagePublish(item);
    channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);

    const first = new AgentDeliveryService();
    first.onChannelReady(channel);
    const pending = first.next(receiver, "key", 5000);
    const delivered = await pending;
    expect(delivered).toMatchObject({ kind: "message", message: item });
    await connection.close();

    connection = await connect(amqpUrl);
    channel = await connection.createChannel();
    const second = new AgentDeliveryService();
    second.onChannelReady(channel);
    const recovered = await second.next(receiver, "key", 5000);
    expect(recovered).toMatchObject({ kind: "message", message: item });
    expect(second.dispose(recovered?.deliveryId ?? "", "key", "ack")).toBe("accepted");
  });

  it("delivers task status events after reconnect and does not recreate a terminal task", async () => {
    const task: Task = { ...createTask({ contextId: ulid(), originInstanceId: origin.instance_id, assigneeInstanceId: receiver }), state: "working" };
    const event = createTaskStatusEvent(task, "completed", { destination: origin.instance_id, body: "done" });
    const spec = toA2ATaskStatusPublish(event);
    statusQueue = agentQueueName(origin.instance_id);
    await channel.assertQueue(statusQueue, { durable: true });
    await channel.bindQueue(statusQueue, EXCHANGE_AGENTS, origin.instance_id);
    await connection.close();

    connection = await connect(amqpUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
    await channel.bindQueue(statusQueue, EXCHANGE_AGENTS, origin.instance_id);
    channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
    const second = new AgentDeliveryService();
    second.onChannelReady(channel);
    const status = await second.next(origin.instance_id, "key", 5000);
    expect(status).toMatchObject({ kind: "task-status", status: event });
    expect(second.dispose(status?.deliveryId ?? "", "key", "ack")).toBe("accepted");
    await channel.deleteQueue(statusQueue);

    const dir = await mkdtemp(join(tmpdir(), "onclave-a2a-terminal-it-"));
    try {
      const path = join(dir, "state.json");
      const store = new TaskStore({ path });
      const tracked = await store.createTrackedTask({ contextId: task.context_id, originInstanceId: origin.instance_id, assigneeInstanceId: receiver });
      await store.updateTask(tracked.task_id, "working");
      await store.updateTask(tracked.task_id, "completed");
      const restored = new TaskStore({ path });
      await restored.load();
      expect(await restored.updateTask(tracked.task_id, "working")).toEqual({ ok: false, error: "terminal_immutable" });
      expect(restored.getTask(tracked.task_id)?.state).toBe("completed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out without cancellation and receives a later message", async () => {
    const service = new AgentDeliveryService();
    service.onChannelReady(channel);
    await expect(service.next(receiver, "key", 25)).resolves.toBeUndefined();

    const item = message("inform");
    const spec = toA2AMessagePublish(item);
    channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
    const delivered = await service.next(receiver, "key", 5000);
    expect(delivered).toMatchObject({ kind: "message", message: item });
    expect(service.dispose(delivered?.deliveryId ?? "", "key", "ack")).toBe("accepted");
  });
});
