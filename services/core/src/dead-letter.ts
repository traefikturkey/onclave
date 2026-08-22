import type { Channel, ConsumeMessage } from "amqplib";
import { createMessage, fromA2AMessage, fromA2ATaskStatus, QUEUE_DEAD_LETTER, toA2AMessagePublish } from "@onclave/envelope";
import { CORE_AGENT_ID, coreOrigin } from "./core-origin";
import { log } from "./log";
import { publishMessage, type CoreServices } from "./rpc";

type DeathInfo = { reason: string; queue: string };
function extractDeath(message: ConsumeMessage): DeathInfo {
  const deaths = message.properties.headers?.["x-death"];
  if (Array.isArray(deaths) && deaths.length > 0) {
    const first = deaths[0] as unknown as Record<string, unknown>;
    return { reason: typeof first.reason === "string" ? first.reason : "unknown", queue: typeof first.queue === "string" ? first.queue : "unknown" };
  }
  return { reason: "unknown", queue: "unknown" };
}

async function handleDeadLetter(services: CoreServices, channel: Channel, message: ConsumeMessage): Promise<void> {
  const death = extractDeath(message);
  const parsed = fromA2AMessage(message);
  if (parsed.ok) {
    await services.audit("dead_letter_received", { reason: death.reason, queue: death.queue, message_id: parsed.message.message_id, context_id: parsed.message.context_id, from_instance_id: parsed.message.origin.instance_id, to_instance_id: parsed.message.destination, type: parsed.message.type });
    if (parsed.message.origin.instance_id !== CORE_AGENT_ID) {
      const advisory = createMessage({ type: "inform", origin: coreOrigin(), destination: parsed.message.origin.instance_id, context_id: parsed.message.context_id, body: `message ${parsed.message.message_id} to ${parsed.message.destination} was dead-lettered (${death.reason}) from queue ${death.queue}` });
      publishMessage(channel, advisory);
      await services.audit("dead_letter_advisory_sent", { message_id: parsed.message.message_id, advisory_id: advisory.message_id, to_instance_id: parsed.message.origin.instance_id });
    }
    return;
  }
  const status = fromA2ATaskStatus(message);
  if (status.ok) {
    await services.audit("dead_letter_received", { reason: death.reason, queue: death.queue, event_id: status.event.event_id, task_id: status.event.task_id, context_id: status.event.context_id, origin_instance_id: status.event.origin_instance_id, destination: status.event.destination, state: status.event.state });
    return;
  }
  await services.audit("dead_letter_unparseable", { reason: death.reason, queue: death.queue, detail: "protocol_version_mismatch or malformed A2A payload" });
}

export async function startDeadLetterConsumer(services: CoreServices, channel: Channel): Promise<void> {
  await channel.consume(QUEUE_DEAD_LETTER, (message) => {
    if (message === null) return;
    void handleDeadLetter(services, channel, message).catch((error: unknown) => log("error", "dead_letter.handler_failed", { message: error instanceof Error ? error.message : String(error) })).finally(() => channel.ack(message));
  });
  log("info", "dead_letter.listening", { queue: QUEUE_DEAD_LETTER });
}
