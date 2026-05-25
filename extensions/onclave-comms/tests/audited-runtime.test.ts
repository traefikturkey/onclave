import { describe, expect, it } from "bun:test";
import { AuditedHubRuntime } from "../src/lib/audited-runtime";
import type { AuditEventName, AuditMetadata } from "../src/lib/audit";
import type { DeliveredPrompt, MessageResponse } from "../src/lib/messages";
import type { LocalAgentRegistration } from "../src/lib/local-registry";

const NOW = "2026-05-21T00:00:00.000Z";

describe("AuditedHubRuntime", () => {
  it("audits lifecycle, trust, and discovery metadata", () => {
    const events: Array<{ event: AuditEventName; metadata: AuditMetadata }> = [];
    const runtime = createRuntime(events);

    runtime.hubStart({ nodeId: "node_local", hubInstanceId: "hub_local", endpoint: "https://127.0.0.1:4444" });
    runtime.trustLoaded({ count: 2 });
    runtime.trustChanged({ action: "add", fingerprint: "SHA256:test", duplicate: false });
    runtime.discoverySeen({ nodeId: "node_peer", endpoint: "wss://192.168.1.20:4444/v1/hub", result: "discovered" });
    runtime.discoveryIgnored({ reason: "invalid_packet", remote: "192.168.1.30" });
    runtime.hubStop({ nodeId: "node_local", hubInstanceId: "hub_local" });

    expect(events).toEqual([
      { event: "hub_start", metadata: { node_id: "node_local", hub_instance_id: "hub_local", endpoint: "https://127.0.0.1:4444" } },
      { event: "trust_loaded", metadata: { count: 2 } },
      { event: "trust_changed", metadata: { action: "add", fingerprint: "SHA256:test", duplicate: false } },
      { event: "discovery_seen", metadata: { node_id: "node_peer", endpoint: "wss://192.168.1.20:4444/v1/hub", result: "discovered" } },
      { event: "discovery_ignored", metadata: { reason: "invalid_packet", remote: "192.168.1.30" } },
      { event: "hub_stop", metadata: { node_id: "node_local", hub_instance_id: "hub_local" } },
    ]);
  });

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
    runtime.authAttempt({ nodeId: "node_peer" });
    runtime.authSuccess({ nodeId: "node_peer", fingerprint: "SHA256:test" });
    runtime.authFailure({ nodeId: "node_peer", reason: "invalid_signature" });

    expect(events).toEqual([
      { event: "response_inbound", metadata: { msg_id: "msg-1", responder_session_id: "session-1", error: null } },
      { event: "auth_attempt", metadata: { node_id: "node_peer" } },
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
