import type { ChannelMessage } from "@onclave/envelope";

export const INBOUND_CUSTOM_TYPE = "onclave-inbound";
export const STATUS_CUSTOM_TYPE = "onclave-channel-status";

/**
 * Session-owned context for an inbound request turn. It is intentionally not a
 * durable waiter or an outbound conversation ledger: responses and notes are
 * ordinary asynchronous channel deliveries, and a session reload starts with
 * no active response context.
 */
export class CorrelationStore {
  private readonly inbound = new Map<string, ChannelMessage>();

  registerInbound(message: ChannelMessage): void {
    if (message.kind !== "request") return;
    this.inbound.set(message.message_id, message);
  }

  getInbound(messageId: string): ChannelMessage | undefined {
    return this.inbound.get(messageId);
  }

  /** Returns the most recently delivered request owned by this Pi session. */
  activeInboundRequest(): ChannelMessage | undefined {
    const requests = [...this.inbound.values()];
    return requests.at(-1);
  }

  completeInbound(messageId: string): void {
    this.inbound.delete(messageId);
  }

  inFlightCount(): number {
    return this.inbound.size;
  }

  clear(): void {
    this.inbound.clear();
  }
}
