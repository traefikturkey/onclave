import type { Channel, ConsumeMessage } from "amqplib";
import { QUEUE_DEAD_LETTER, createEnvelope, fromAmqpMessage } from "@onclave/envelope";
import { CORE_AGENT_ID, coreOrigin } from "./core-origin";
import { log } from "./log";
import { publishEnvelope, type CoreServices } from "./rpc";

type DeathInfo = {
  reason: string;
  queue: string;
};

function extractDeath(message: ConsumeMessage): DeathInfo {
  const deaths = message.properties.headers?.["x-death"];
  if (Array.isArray(deaths) && deaths.length > 0) {
    const first = deaths[0] as unknown as Record<string, unknown>;
    return {
      reason: typeof first.reason === "string" ? first.reason : "unknown",
      queue: typeof first.queue === "string" ? first.queue : "unknown",
    };
  }
  return { reason: "unknown", queue: "unknown" };
}

async function handleDeadLetter(
  services: CoreServices,
  channel: Channel,
  message: ConsumeMessage
): Promise<void> {
  const death = extractDeath(message);
  const parsed = fromAmqpMessage(message);
  if (!parsed.ok) {
    await services.audit("dead_letter_unparseable", {
      reason: death.reason,
      queue: death.queue,
      detail: parsed.error,
    });
    return;
  }
  const envelope = parsed.envelope;
  await services.audit("dead_letter_received", {
    reason: death.reason,
    queue: death.queue,
    message_id: envelope.id,
    conversation_id: envelope.conversation_id,
    from_agent_id: envelope.from.agent_id,
    to_agent_id: envelope.to,
    performative: envelope.performative,
  });
  if (envelope.from.agent_id === CORE_AGENT_ID) {
    return;
  }
  const advisory = createEnvelope({
    performative: "inform",
    from: coreOrigin(),
    to: envelope.from.agent_id,
    body: `message ${envelope.id} to ${envelope.to} was dead-lettered (${death.reason}) from queue ${death.queue}`,
    conversationId: envelope.conversation_id,
  });
  publishEnvelope(channel, advisory);
  await services.audit("dead_letter_advisory_sent", {
    message_id: envelope.id,
    advisory_id: advisory.id,
    to_agent_id: envelope.from.agent_id,
  });
}

export async function startDeadLetterConsumer(
  services: CoreServices,
  channel: Channel
): Promise<void> {
  await channel.consume(QUEUE_DEAD_LETTER, (message) => {
    if (message === null) return;
    void handleDeadLetter(services, channel, message)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        log("error", "dead_letter.handler_failed", { message: detail });
      })
      .finally(() => {
        channel.ack(message);
      });
  });
  log("info", "dead_letter.listening", { queue: QUEUE_DEAD_LETTER });
}
