import type { LocalAgentRegistry } from "./local-registry";
import type { SendPromptFrame } from "./transport";

export type MessageStatus = "queued" | "delivered" | "complete" | "error" | "timeout";

export type DeliveredPrompt = {
  msgId: string;
  targetSessionId: string;
  deliveryEndpoint: string;
  prompt: string;
  hops: number;
  receivedAt: string;
};

export type RoutedMessage = {
  msgId: string;
  targetSessionId: string;
  prompt: string;
  hops: number;
  status: MessageStatus;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
  completedAt?: string;
  response?: unknown;
  error?: string | null;
};

export type MessageResponse = {
  msgId: string;
  responderSessionId: string;
  response: unknown;
  error: string | null;
  completedAt: string;
};

export type SendPromptResult =
  | { ok: true; msgId: string; status: "delivered" }
  | { ok: false; error: "target_not_found" | "hop_limit_exceeded" | "delivery_failed" };

export type SubmitResponseResult =
  | { ok: true; status: "complete" | "error" }
  | { ok: false; error: "message_not_found" | "responder_mismatch" };

export type MessageResponseLookup =
  | { status: "pending" }
  | { status: "complete" | "error"; response: unknown; error: string | null }
  | { status: "timeout"; error: "timeout" }
  | { status: "unknown"; error: "message_not_found" };

export type MessageRouterOptions = {
  registry: LocalAgentRegistry;
  now: () => string;
  ttlMs: number;
  maxHops: number;
  deliverPrompt: (prompt: DeliveredPrompt) => Promise<void>;
};

export class MessageRouter {
  private readonly messages = new Map<string, RoutedMessage>();

  constructor(private readonly options: MessageRouterOptions) {
    if (options.ttlMs <= 0) throw new Error("message ttl must be positive");
    if (options.maxHops <= 0) throw new Error("message hop limit must be positive");
  }

  async sendPrompt(frame: SendPromptFrame): Promise<SendPromptResult> {
    if (frame.hops >= this.options.maxHops) {
      return { ok: false, error: "hop_limit_exceeded" };
    }

    const target = this.options.registry.get(frame.targetSessionId);
    if (!target) return { ok: false, error: "target_not_found" };

    const now = this.options.now();
    const message: RoutedMessage = {
      msgId: frame.msgId,
      targetSessionId: frame.targetSessionId,
      prompt: frame.prompt,
      hops: frame.hops,
      status: "queued",
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + this.options.ttlMs).toISOString(),
    };
    this.messages.set(frame.msgId, message);

    try {
      await this.options.deliverPrompt({
        msgId: frame.msgId,
        targetSessionId: frame.targetSessionId,
        deliveryEndpoint: target.deliveryEndpoint,
        prompt: frame.prompt,
        hops: frame.hops,
        receivedAt: now,
      });
    } catch {
      this.messages.set(frame.msgId, { ...message, status: "error", error: "delivery_failed" });
      return { ok: false, error: "delivery_failed" };
    }

    this.messages.set(frame.msgId, { ...message, status: "delivered", deliveredAt: now });
    return { ok: true, msgId: frame.msgId, status: "delivered" };
  }

  submitResponse(response: MessageResponse): SubmitResponseResult {
    const message = this.messages.get(response.msgId);
    if (!message) return { ok: false, error: "message_not_found" };
    if (message.targetSessionId !== response.responderSessionId) {
      return { ok: false, error: "responder_mismatch" };
    }

    const status: "complete" | "error" = response.error ? "error" : "complete";
    this.messages.set(response.msgId, {
      ...message,
      status,
      response: response.response,
      error: response.error,
      completedAt: response.completedAt,
    });
    return { ok: true, status };
  }

  cleanupExpired(now: string): string[] {
    const nowMs = Date.parse(now);
    if (Number.isNaN(nowMs)) throw new Error(`invalid cleanup timestamp: ${now}`);

    const expired: string[] = [];
    for (const [msgId, message] of this.messages) {
      if (message.status !== "queued" && message.status !== "delivered") continue;
      const expiresAtMs = Date.parse(message.expiresAt);
      if (!Number.isNaN(expiresAtMs) && nowMs > expiresAtMs) {
        this.messages.set(msgId, { ...message, status: "timeout", error: "timeout" });
        expired.push(msgId);
      }
    }
    return expired;
  }

  getResponse(msgId: string): MessageResponseLookup {
    const message = this.messages.get(msgId);
    if (!message) return { status: "unknown", error: "message_not_found" };
    if (message.status === "complete" || message.status === "error") {
      return {
        status: message.status,
        response: message.response,
        error: message.error ?? null,
      };
    }
    if (message.status === "timeout") return { status: "timeout", error: "timeout" };
    return { status: "pending" };
  }

  getMessage(msgId: string): RoutedMessage | null {
    return this.messages.get(msgId) ?? null;
  }
}
