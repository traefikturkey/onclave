import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { Channel, ConsumeMessage } from "amqplib";
import { agentQueueName, createMessage, toA2AMessagePublish, type A2AOrigin, type Message } from "@onclave/envelope";
import { AgentDeliveryService } from "../src/agent-delivery";

const card = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "test-host",
};

type Consumer = {
  queue: string;
  callback: (message: ConsumeMessage | null) => void;
};

class FakeChannel extends EventEmitter {
  readonly acknowledged: ConsumeMessage[] = [];
  readonly rejected: Array<{ message: ConsumeMessage; requeue: boolean }> = [];
  private readonly consumers = new Map<string, Consumer>();
  private readonly queued = new Map<string, ConsumeMessage[]>();
  private nextConsumer = 0;

  async consume(queue: string, callback: (message: ConsumeMessage | null) => void): Promise<{ consumerTag: string }> {
    const consumerTag = `consumer-${this.nextConsumer}`;
    this.nextConsumer += 1;
    this.consumers.set(consumerTag, { queue, callback });
    this.dispatch(queue);
    return { consumerTag };
  }

  async cancel(consumerTag: string): Promise<void> {
    this.consumers.delete(consumerTag);
  }

  ack(message: ConsumeMessage): void {
    this.acknowledged.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo: boolean, requeue: boolean): void {
    this.rejected.push({ message, requeue });
    if (!requeue) return;
    const queue = String(message.fields.consumerTag ?? "");
    const messages = this.queued.get(queue) ?? [];
    messages.push(message);
    this.queued.set(queue, messages);
  }

  enqueue(agentId: string, item: Message): void {
    const spec = toA2AMessagePublish(item);
    const queue = agentQueueName(agentId);
    const message = {
      content: spec.content,
      fields: { consumerTag: queue },
      properties: spec.options,
    } as unknown as ConsumeMessage;
    const messages = this.queued.get(queue) ?? [];
    messages.push(message);
    this.queued.set(queue, messages);
    this.dispatch(queue);
  }

  private dispatch(queue: string): void {
    const consumer = [...this.consumers.values()].find((candidate) => candidate.queue === queue);
    const messages = this.queued.get(queue);
    const message = messages?.shift();
    if (consumer !== undefined && message !== undefined) consumer.callback(message);
  }
}

function message(): Message {
  const origin: A2AOrigin = { instance_id: card.agent_id, name: card.name, host: card.host };
  return createMessage({
    context_id: "01J00000000000000000000000",
    type: "request",
    origin,
    destination: card.agent_id,
    body: "hello",
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AgentDeliveryService", () => {
  it("requeues an unacknowledged delivery when its lease expires and delivers it again", async () => {
    const channel = new FakeChannel();
    const deliveries = new AgentDeliveryService({ leaseMs: 10 });
    deliveries.onChannelReady(channel as unknown as Channel);
    const item = message();

    const firstPromise = deliveries.next(card.agent_id, "key-a", 100);
    channel.enqueue(card.agent_id, item);
    const first = await firstPromise;
    expect(first).toMatchObject({ kind: "message", message: item });
    await Promise.resolve();

    await sleep(25);
    expect(channel.rejected).toContainEqual({ message: expect.anything(), requeue: true });

    const second = await deliveries.next(card.agent_id, "key-a", 100);
    expect(second).toMatchObject({ kind: "message", message: item });
    expect(second?.deliveryId).not.toBe(first?.deliveryId);
    expect(deliveries.dispose(second?.deliveryId ?? "", "key-a", "ack")).toBe("accepted");
    expect(channel.acknowledged).toHaveLength(1);
  });

  it("nacks rejects without requeue so the configured queue DLX receives the message", async () => {
    const channel = new FakeChannel();
    const deliveries = new AgentDeliveryService();
    deliveries.onChannelReady(channel as unknown as Channel);

    const pending = deliveries.next(card.agent_id, "key-a", 100);
    channel.enqueue(card.agent_id, message());
    const delivered = await pending;
    expect(deliveries.dispose(delivered?.deliveryId ?? "", "key-a", "reject")).toBe("accepted");
    expect(channel.rejected).toContainEqual({ message: expect.anything(), requeue: false });
  });

  it("rejects pending polls immediately when the broker channel closes", async () => {
    const channel = new FakeChannel();
    const deliveries = new AgentDeliveryService();
    deliveries.onChannelReady(channel as unknown as Channel);

    const pending = deliveries.next(card.agent_id, "operator-key", 10_000);
    channel.emit("close");

    await expect(pending).rejects.toThrow("Broker unavailable");
    await expect(deliveries.next(card.agent_id, "operator-key", 0)).rejects.toThrow("Broker unavailable");
  });
});
