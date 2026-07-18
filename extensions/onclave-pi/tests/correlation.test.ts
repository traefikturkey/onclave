import { describe, expect, it } from "vitest";
import { createEnvelope, type AgentOrigin } from "@onclave/envelope";
import { CorrelationStore, INBOUND_CUSTOM_TYPE } from "../src/lib/correlation";

const sender: AgentOrigin = { agent_id: "peer", name: "Peer", host: "host-1" };

function inbound(body: string) {
  return createEnvelope({ performative: "request", from: sender, to: "me", body });
}

function runMessage(msgId: string): unknown {
  return { customType: INBOUND_CUSTOM_TYPE, details: { msgId } };
}

describe("CorrelationStore strict matching", () => {
  it("matches a run to its own inbound message id", () => {
    const store = new CorrelationStore();
    const envelope = inbound("work");
    store.registerInbound(envelope);
    const matched = store.matchAgentRun([{ role: "user" }, runMessage(envelope.id)]);
    expect(matched?.id).toBe(envelope.id);
  });

  it("resolves two overlapping inbound requests to their own ids", () => {
    const store = new CorrelationStore();
    const first = inbound("first");
    const second = inbound("second");
    store.registerInbound(first);
    store.registerInbound(second);
    expect(store.matchAgentRun([runMessage(first.id)])?.id).toBe(first.id);
    expect(store.matchAgentRun([runMessage(second.id)])?.id).toBe(second.id);
  });

  it("returns nothing when the run carries no known inbound id (no fallback)", () => {
    const store = new CorrelationStore();
    store.registerInbound(inbound("pending work"));
    expect(store.matchAgentRun([{ role: "user" }, { role: "assistant" }])).toBeUndefined();
    expect(store.matchAgentRun([runMessage("01ARZ3NDEKTSV4RRFFQ69G5FAV")])).toBeUndefined();
  });

  it("prefers the latest inbound id present in the run messages", () => {
    const store = new CorrelationStore();
    const first = inbound("first");
    const second = inbound("second");
    store.registerInbound(first);
    store.registerInbound(second);
    const matched = store.matchAgentRun([runMessage(first.id), runMessage(second.id)]);
    expect(matched?.id).toBe(second.id);
  });

  it("stops matching after completion", () => {
    const store = new CorrelationStore();
    const envelope = inbound("done");
    store.registerInbound(envelope);
    store.completeInbound(envelope.id);
    expect(store.matchAgentRun([runMessage(envelope.id)])).toBeUndefined();
  });
});

describe("CorrelationStore reply capture", () => {
  it("accepts replies only for pending outbound messages", () => {
    const store = new CorrelationStore();
    const outbound = inbound("question");
    store.registerOutbound(outbound);
    const reply = createEnvelope({
      performative: "inform",
      from: sender,
      to: "me",
      body: "answer",
      conversationId: outbound.conversation_id,
      inReplyTo: outbound.id,
    });
    expect(store.acceptReply(reply)).toBe(true);
    expect(store.getReply(outbound.id)?.body).toBe("answer");
    expect(store.hasPendingOutbound(outbound.id)).toBe(false);
  });

  it("drops replies without a matching outbound correlation", () => {
    const store = new CorrelationStore();
    const stray = createEnvelope({
      performative: "inform",
      from: sender,
      to: "me",
      body: "stray",
      inReplyTo: inbound("never sent").id,
    });
    expect(store.acceptReply(stray)).toBe(false);
    const noReplyTo = createEnvelope({
      performative: "inform",
      from: sender,
      to: "me",
      body: "no reply field",
    });
    expect(store.acceptReply(noReplyTo)).toBe(false);
  });
});
