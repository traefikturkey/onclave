import { describe, expect, it } from "vitest";
import { agentQueueName, fromAmqpMessage, parseExpiration, toAmqpPublish } from "../src/amqp";
import { createEnvelope, type AgentOrigin, type CreateEnvelopeInput } from "../src/envelope";

const sender: AgentOrigin = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "host-1",
  project: "onclave",
};

const fullInput: CreateEnvelopeInput = {
  performative: "request",
  from: sender,
  to: "agent-b",
  body: "check the deployment",
  ttlMs: 30000,
  traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
  schema: "text/plain",
  usage: { input_tokens: 5, output_tokens: 7 },
};

function fullEnvelope() {
  return createEnvelope(fullInput);
}

function toConsumed(spec: ReturnType<typeof toAmqpPublish>) {
  return {
    content: spec.content,
    properties: {
      messageId: spec.options.messageId,
      correlationId: spec.options.correlationId,
      expiration: spec.options.expiration,
      headers: spec.options.headers,
    },
  };
}

describe("toAmqpPublish", () => {
  it("maps envelope fields onto native AMQP properties", () => {
    const envelope = fullEnvelope();
    const spec = toAmqpPublish(envelope);
    expect(spec.routingKey).toBe("agent-b");
    expect(spec.options.messageId).toBe(envelope.id);
    expect(spec.options.correlationId).toBe(envelope.conversation_id);
    expect(spec.options.expiration).toBe("30000");
    expect(spec.options.replyTo).toBe(agentQueueName(sender.agent_id));
    expect(spec.options.persistent).toBe(true);
    expect(spec.options.headers.performative).toBe("request");
    expect(spec.options.headers.hops).toBe(0);
  });

  it("omits expiration when the envelope has no ttl", () => {
    const envelope = createEnvelope({
      performative: "inform",
      from: sender,
      to: "agent-b",
      body: "fyi",
    });
    expect(toAmqpPublish(envelope).options.expiration).toBeUndefined();
  });
});

describe("fromAmqpMessage", () => {
  it("round-trips an envelope through AMQP property shapes", () => {
    const envelope = fullEnvelope();
    const parsed = fromAmqpMessage(toConsumed(toAmqpPublish(envelope)));
    expect(parsed).toEqual({ ok: true, envelope });
  });

  it("round-trips a minimal envelope", () => {
    const envelope = createEnvelope({
      performative: "inform",
      from: { agent_id: "a", name: "A", host: "h" },
      to: "b",
      body: "",
    });
    const parsed = fromAmqpMessage(toConsumed(toAmqpPublish(envelope)));
    expect(parsed).toEqual({ ok: true, envelope });
  });

  it("rejects non-JSON content", () => {
    const spec = toAmqpPublish(fullEnvelope());
    const consumed = { ...toConsumed(spec), content: Buffer.from("not json", "utf8") };
    expect(fromAmqpMessage(consumed)).toMatchObject({ ok: false });
  });

  it("rejects a missing or malformed origin header", () => {
    const spec = toAmqpPublish(fullEnvelope());
    const consumed = toConsumed(spec);
    consumed.properties.headers = { ...consumed.properties.headers, origin: "{broken" };
    expect(fromAmqpMessage(consumed)).toMatchObject({
      ok: false,
      error: "origin header is not a valid agent origin card",
    });
  });

  it("rejects a malformed usage header", () => {
    const spec = toAmqpPublish(fullEnvelope());
    const consumed = toConsumed(spec);
    consumed.properties.headers = { ...consumed.properties.headers, usage: "[]" };
    expect(fromAmqpMessage(consumed)).toMatchObject({
      ok: false,
      error: "usage header is not a JSON object",
    });
  });

  it("rejects when required headers are absent", () => {
    const spec = toAmqpPublish(fullEnvelope());
    const consumed = toConsumed(spec);
    consumed.properties.headers = { origin: consumed.properties.headers.origin };
    expect(fromAmqpMessage(consumed)).toMatchObject({ ok: false });
  });

  it("ignores unparseable expiration values", () => {
    expect(parseExpiration("abc")).toBeUndefined();
    expect(parseExpiration("")).toBeUndefined();
    expect(parseExpiration("-5")).toBeUndefined();
    expect(parseExpiration(5000)).toBeUndefined();
    expect(parseExpiration("5000")).toBe(5000);
  });
});
