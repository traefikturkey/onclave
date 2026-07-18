import type { Envelope } from "@onclave/envelope";

export const INBOUND_CUSTOM_TYPE = "onclave-inbound";

// Strict reply correlation: an agent run submits a reply only when one of its
// own messages carries a known in-flight inbound message id. There is no
// latest-inbound fallback; unmatched runs submit nothing (audited by caller).
export class CorrelationStore {
  private readonly inFlight = new Map<string, Envelope>();
  private readonly pendingOutbound = new Map<string, Envelope>();
  private readonly replies = new Map<string, Envelope>();

  registerInbound(envelope: Envelope): void {
    this.inFlight.set(envelope.id, envelope);
  }

  completeInbound(messageId: string): void {
    this.inFlight.delete(messageId);
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  matchAgentRun(messages: unknown[]): Envelope | undefined {
    for (const message of [...messages].reverse()) {
      const messageId = inboundMessageId(message);
      if (messageId === undefined) continue;
      const envelope = this.inFlight.get(messageId);
      if (envelope !== undefined) return envelope;
    }
    return undefined;
  }

  registerOutbound(envelope: Envelope): void {
    this.pendingOutbound.set(envelope.id, envelope);
  }

  // Accepts a reply for a pending outbound message; returns false when the
  // reply does not correlate to anything this session sent.
  acceptReply(reply: Envelope): boolean {
    if (reply.in_reply_to === undefined) return false;
    if (!this.pendingOutbound.has(reply.in_reply_to)) return false;
    this.pendingOutbound.delete(reply.in_reply_to);
    this.replies.set(reply.in_reply_to, reply);
    return true;
  }

  getReply(messageId: string): Envelope | undefined {
    return this.replies.get(messageId);
  }

  hasPendingOutbound(messageId: string): boolean {
    return this.pendingOutbound.has(messageId);
  }

  clear(): void {
    this.inFlight.clear();
    this.pendingOutbound.clear();
    this.replies.clear();
  }
}

function inboundMessageId(message: unknown): string | undefined {
  if (message === null || typeof message !== "object") return undefined;
  const record = message as { customType?: unknown; details?: { msgId?: unknown } };
  if (record.customType !== INBOUND_CUSTOM_TYPE) return undefined;
  const msgId = record.details?.msgId;
  return typeof msgId === "string" ? msgId : undefined;
}
