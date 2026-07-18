import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_HOPS,
  ENVELOPE_VERSION,
  buildFailureReply,
  buildNotUnderstoodReply,
  createEnvelope,
  incrementHops,
  parseEnvelope,
  type AgentOrigin,
} from "../src/envelope";

const sender: AgentOrigin = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "host-1",
  project: "onclave",
};

const receiver: AgentOrigin = {
  agent_id: "agent-b",
  name: "Agent B",
  host: "host-2",
};

function validEnvelope() {
  return createEnvelope({
    performative: "request",
    from: sender,
    to: "agent-b",
    body: "please summarize the build status",
    ttlMs: 60000,
  });
}

describe("createEnvelope", () => {
  it("produces a parseable envelope with fresh ids", () => {
    const envelope = validEnvelope();
    expect(envelope.v).toBe(ENVELOPE_VERSION);
    expect(envelope.hops).toBe(0);
    const parsed = parseEnvelope(envelope);
    expect(parsed.ok).toBe(true);
  });

  it("keeps the caller-provided conversation id", () => {
    const first = validEnvelope();
    const second = createEnvelope({
      performative: "query",
      from: sender,
      to: "agent-b",
      body: "status?",
      conversationId: first.conversation_id,
    });
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(second.id).not.toBe(first.id);
  });
});

describe("parseEnvelope", () => {
  it("accepts a fully populated envelope", () => {
    const envelope = {
      ...validEnvelope(),
      in_reply_to: validEnvelope().id,
      traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01",
      schema: "text/plain",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const parsed = parseEnvelope(envelope);
    expect(parsed).toEqual({ ok: true, envelope });
  });

  it.each([
    ["non-object", "nope"],
    ["wrong version", { ...validEnvelope(), v: 2 }],
    ["bad id", { ...validEnvelope(), id: "123" }],
    ["bad conversation id", { ...validEnvelope(), conversation_id: "abc" }],
    ["unknown performative", { ...validEnvelope(), performative: "command" }],
    ["missing origin", { ...validEnvelope(), from: undefined }],
    ["origin without host", { ...validEnvelope(), from: { agent_id: "x", name: "y" } }],
    ["empty target", { ...validEnvelope(), to: "" }],
    ["negative hops", { ...validEnvelope(), hops: -1 }],
    ["fractional hops", { ...validEnvelope(), hops: 1.5 }],
    ["non-string body", { ...validEnvelope(), body: 42 }],
    ["bad timestamp", { ...validEnvelope(), sent_at: "yesterday" }],
    ["bad reply id", { ...validEnvelope(), in_reply_to: "nope" }],
    ["zero ttl", { ...validEnvelope(), ttl_ms: 0 }],
    ["negative usage", { ...validEnvelope(), usage: { input_tokens: -1, output_tokens: 0 } }],
  ])("rejects %s", (_label, value) => {
    expect(parseEnvelope(value).ok).toBe(false);
  });
});

describe("incrementHops", () => {
  it("increments below the cap", () => {
    const result = incrementHops(validEnvelope());
    expect(result).toMatchObject({ ok: true, envelope: { hops: 1 } });
  });

  it("rejects past the cap", () => {
    const envelope = { ...validEnvelope(), hops: DEFAULT_MAX_HOPS };
    expect(incrementHops(envelope)).toEqual({ ok: false, error: "hop_limit_exceeded" });
  });

  it("honors a custom cap", () => {
    const envelope = { ...validEnvelope(), hops: 2 };
    expect(incrementHops(envelope, 2)).toEqual({ ok: false, error: "hop_limit_exceeded" });
  });
});

describe("reply builders", () => {
  it("correlates failure replies to the original message", () => {
    const original = validEnvelope();
    const reply = buildFailureReply({
      original,
      from: receiver,
      body: "budget exceeded",
    });
    expect(reply.performative).toBe("failure");
    expect(reply.conversation_id).toBe(original.conversation_id);
    expect(reply.in_reply_to).toBe(original.id);
    expect(reply.to).toBe(sender.agent_id);
    expect(parseEnvelope(reply).ok).toBe(true);
  });

  it("builds not_understood replies with usage metadata", () => {
    const original = validEnvelope();
    const reply = buildNotUnderstoodReply({
      original,
      from: receiver,
      body: "malformed envelope",
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    expect(reply.performative).toBe("not_understood");
    expect(reply.usage).toEqual({ input_tokens: 1, output_tokens: 2 });
    expect(reply.in_reply_to).toBe(original.id);
  });
});
