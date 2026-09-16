import { connect } from "amqplib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXCHANGE_AGENTS, agentQueueName, createChannelMessage, toChannelMessagePublish, ulid } from "@onclave/envelope";
import { AgentDeliveryService } from "../src/agent-delivery";

const amqpUrl = process.env.ONCLAVE_TEST_AMQP_URL ?? "";
const describeIntegration = amqpUrl === "" ? describe.skip : describe;
const receiver = `channel-delivery-${ulid().toLowerCase()}`;

describeIntegration("channel broker delivery retention", () => {
  let connection: Awaited<ReturnType<typeof connect>>;
  let channel: Awaited<ReturnType<typeof connection.createChannel>>;
  let queue: string;

  beforeEach(async () => {
    connection = await connect(amqpUrl);
    channel = await connection.createChannel();
    await channel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
    queue = agentQueueName(receiver);
    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EXCHANGE_AGENTS, receiver);
  });

  afterEach(async () => {
    await channel.deleteQueue(queue).catch(() => undefined);
    await connection.close().catch(() => undefined);
  });

  it("delivers a durable channel event through the participant mailbox", async () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "note", origin: { instance_id: "origin", name: "Origin", host: "host" }, participants: ["origin", receiver], body: "retained message" });
    const spec = toChannelMessagePublish(message, receiver);
    channel.publish(EXCHANGE_AGENTS, spec.routingKey, spec.content, spec.options);
    const service = new AgentDeliveryService();
    service.onChannelReady(channel);
    const delivered = await service.next(receiver, "key", 5000);
    expect(delivered).toMatchObject({ kind: "message", message });
    expect(service.dispose(delivered?.deliveryId ?? "", "key", "ack")).toBe("accepted");
  });
});
