import { describe, expect, it } from "bun:test";
import { AuditedHubRuntime } from "../../src/coms-lan/audited-runtime";
import type { AuditEventName, AuditMetadata } from "../../src/coms-lan/audit";
import type { DeliveredPrompt, MessageResponse } from "../../src/coms-lan/messages";
import type { LocalAgentRegistration } from "../../src/coms-lan/local-registry";

const NOW = "2026-05-21T00:00:00.000Z";

describe("AuditedHubRuntime", () => {
  it("audits local registration and unregister", () => {
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const runtime = createRuntime(events);

    runtime.localRegister(createRegistration());
    runtime.localUnregister("session-1", true);

    expect(events).toEqual([
      { event: "local_register", metadata: { session_id: "session-1", name: "agent-one", project: "onclave@main" } },
      { event: "local_unregister", metadata: { session_id: "session-1", removed: true } },
    ]);
  });

  it("audits inbound and outbound messages without prompt bodies", () => {
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const runtime = createRuntime(events);
    const delivered: DeliveredPrompt = {
      msgId: "msg-1",
      targetSessionId: "session-1",
      deliveryEndpoint: "local://session-1",
      prompt: "do not log me",
      hops: 0,
      receivedAt: NOW,
    };

    runtime.messageInbound(delivered);
    runtime.messageOutbound({ msgId: "msg-1", targetSessionId: "session-1", status: "delivered" });

    expect(events).toEqual([
      { event: "message_inbound", metadata: { msg_id: "msg-1", target_session_id: "session-1", hops: 0 } },
      { event: "message_outbound", metadata: { msg_id: "msg-1", target_session_id: "session-1", status: "delivered" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("do not log me");
  });

  it("audits response and auth events", () => {
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const runtime = createRuntime(events);
    const response: MessageResponse = {
      msgId: "msg-1",
      responderSessionId: "session-1",
      response: "do not log me",
      error: null,
      completedAt: NOW,
    };

    runtime.responseInbound(response);
    runtime.authSuccess({ nodeId: "node_peer", fingerprint: "SHA256:test" });
    runtime.authFailure({ nodeId: "node_peer", reason: "invalid_signature" });

    expect(events).toEqual([
      { event: "response_inbound", metadata: { msg_id: "msg-1", responder_session_id: "session-1", error: null } },
      { event: "auth_success", metadata: { node_id: "node_peer", fingerprint: "SHA256:test" } },
      { event: "auth_failure", metadata: { node_id: "node_peer", reason: "invalid_signature" } },
    ]);
    expect(JSON.stringify(events)).not.toContain("do not log me");
  });
});

function createRuntime(events: Array<{ event: AuditEventName; metadata: AuditMetadata }>): AuditedHubRuntime {
  return new AuditedHubRuntime({
    audit: (event, metadata) => {
      events.push({ event, metadata });
    },
  });
}

function createRegistration(): LocalAgentRegistration {
  return {
    sessionId: "session-1",
    instanceId: "pi-instance-1",
    name: "agent-one",
    projectLabel: "onclave@main",
    model: "test-model",
    purpose: "testing",
    color: "#336699",
    explicit: false,
    deliveryEndpoint: "local://session-1",
  };
}
