import { randomBytes } from "node:crypto";
import type { Channel } from "amqplib";
import { QUEUE_CORE_RPC } from "@onclave/envelope";

const DIRECT_REPLY_TO = "amq.rabbitmq.reply-to";

type PendingCall = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

// AMQP RPC client using RabbitMQ direct reply-to, one instance per channel.
export class CoreRpcClient {
  private readonly pending = new Map<string, PendingCall>();
  private started = false;

  constructor(
    private readonly channel: Channel,
    private readonly timeoutMs = 10000
  ) {}

  async init(): Promise<void> {
    if (this.started) return;
    await this.channel.consume(
      DIRECT_REPLY_TO,
      (message) => {
        if (message === null) return;
        this.dispatch(message.properties.correlationId, message.content);
      },
      { noAck: true }
    );
    this.started = true;
  }

  private dispatch(correlationId: unknown, content: Buffer): void {
    if (typeof correlationId !== "string") return;
    const pending = this.pending.get(correlationId);
    if (pending === undefined) return;
    this.pending.delete(correlationId);
    clearTimeout(pending.timer);
    try {
      pending.resolve(JSON.parse(content.toString("utf8")) as Record<string, unknown>);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  failAll(reason: string): void {
    for (const [correlationId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(correlationId);
    }
  }

  async call(request: object): Promise<Record<string, unknown>> {
    if (!this.started) {
      throw new Error("rpc client is not initialized");
    }
    const correlationId = randomBytes(12).toString("hex");
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(correlationId);
        reject(new Error(`rpc timeout after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(correlationId, { resolve, reject, timer });
    });
    this.channel.sendToQueue(QUEUE_CORE_RPC, Buffer.from(JSON.stringify(request), "utf8"), {
      correlationId,
      replyTo: DIRECT_REPLY_TO,
      contentType: "application/json",
    });
    return promise;
  }
}
