import { randomUUID } from "node:crypto";
import type { Channel, ConsumeMessage } from "amqplib";
import { agentQueueName, fromAmqpMessage, type Envelope } from "@onclave/envelope";

export const DEFAULT_DELIVERY_LEASE_MS = 30_000;

export type DeliveredAgentMessage = {
  deliveryId: string;
  envelope: Envelope;
};

type DeliveryLease = {
  keyId: string;
  channel: Channel;
  message: ConsumeMessage;
  timer: NodeJS.Timeout;
};

type PendingPoll = {
  channel: Channel;
  fail: (error: Error) => void;
};

export type DeliveryDisposition = "ack" | "reject";

export type DeliveryDispositionResult = "accepted" | "not_found" | "wrong_key";

export type AgentDeliveryServiceOptions = {
  leaseMs?: number;
};

/**
 * Holds RabbitMQ delivery ownership until an HTTPS client acknowledges or
 * rejects the message. All delivery state is intentionally process-local.
 */
export class AgentDeliveryService {
  private readonly leaseMs: number;
  private readonly deliveries = new Map<string, DeliveryLease>();
  private readonly pendingPolls = new Set<PendingPoll>();
  private activeChannel: Channel | undefined;

  constructor(options: AgentDeliveryServiceOptions = {}) {
    this.leaseMs = options.leaseMs ?? DEFAULT_DELIVERY_LEASE_MS;
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1) {
      throw new Error("leaseMs must be a positive safe integer");
    }
  }

  onChannelReady(channel: Channel): void {
    this.activeChannel = channel;
    channel.once("close", () => {
      if (this.activeChannel === channel) this.activeChannel = undefined;
      this.releaseChannel(channel);
    });
  }

  async next(agentId: string, keyId: string, waitMs: number): Promise<DeliveredAgentMessage | undefined> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      throw new Error("waitMs must be a non-negative safe integer");
    }
    const channel = this.activeChannel;
    if (channel === undefined) {
      throw new Error("Broker unavailable");
    }

    return new Promise<DeliveredAgentMessage | undefined>((resolve, reject) => {
      let consumerTag: string | undefined;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let pending: PendingPoll | undefined;

      const cancel = (): void => {
        if (consumerTag === undefined) return;
        void channel.cancel(consumerTag).catch(() => undefined);
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (pending !== undefined) this.pendingPolls.delete(pending);
        cancel();
      };
      const settle = (result: DeliveredAgentMessage | undefined): void => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      pending = { channel, fail: (error) => fail(error) };
      this.pendingPolls.add(pending);
      const receive = (message: ConsumeMessage | null): void => {
        if (message === null) return;
        if (settled) {
          this.requeue(channel, message);
          return;
        }
        const parsed = fromAmqpMessage(message);
        if (!parsed.ok) {
          this.reject(channel, message);
          return;
        }
        settle(this.claim(channel, message, keyId, parsed.envelope));
      };

      timer = setTimeout(() => settle(undefined), waitMs);
      timer.unref();
      void channel.consume(agentQueueName(agentId), receive, { noAck: false })
        .then((result) => {
          consumerTag = result.consumerTag;
          if (settled) cancel();
        })
        .catch(fail);
    });
  }

  dispose(deliveryId: string, keyId: string, disposition: DeliveryDisposition): DeliveryDispositionResult {
    const lease = this.deliveries.get(deliveryId);
    if (lease === undefined) return "not_found";
    if (lease.keyId !== keyId) return "wrong_key";

    this.deliveries.delete(deliveryId);
    clearTimeout(lease.timer);
    if (disposition === "ack") {
      lease.channel.ack(lease.message);
    } else {
      this.reject(lease.channel, lease.message);
    }
    return "accepted";
  }

  close(): void {
    const channel = this.activeChannel;
    this.activeChannel = undefined;
    if (channel !== undefined) this.releaseChannel(channel);
  }

  private claim(channel: Channel, message: ConsumeMessage, keyId: string, envelope: Envelope): DeliveredAgentMessage {
    const deliveryId = randomUUID();
    const timer = setTimeout(() => this.expire(deliveryId), this.leaseMs);
    timer.unref();
    this.deliveries.set(deliveryId, { keyId, channel, message, timer });
    return { deliveryId, envelope };
  }

  private expire(deliveryId: string): void {
    const lease = this.deliveries.get(deliveryId);
    if (lease === undefined) return;
    this.deliveries.delete(deliveryId);
    this.requeue(lease.channel, lease.message);
  }

  private releaseChannel(channel: Channel): void {
    for (const pending of this.pendingPolls) {
      if (pending.channel === channel) pending.fail(new Error("Broker unavailable"));
    }
    for (const [deliveryId, lease] of this.deliveries) {
      if (lease.channel !== channel) continue;
      clearTimeout(lease.timer);
      this.deliveries.delete(deliveryId);
    }
  }

  private requeue(channel: Channel, message: ConsumeMessage): void {
    try {
      channel.nack(message, false, true);
    } catch {
      // A closed channel requeues all outstanding unacknowledged deliveries.
    }
  }

  private reject(channel: Channel, message: ConsumeMessage): void {
    try {
      channel.nack(message, false, false);
    } catch {
      // A closed channel requeues all outstanding unacknowledged deliveries.
    }
  }
}
