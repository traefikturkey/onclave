import { describe, expect, it } from "vitest";
import { isAgentCard, parseRpcRequest, PROTOCOL_VERSION } from "../src/protocol";
import { ulid } from "../src/ulid";

const card = {
  agent_id: "agent-a",
  name: "Agent A",
  host: "host-a",
  transport: "https" as const,
};

describe("channel RPC transport", () => {
  it("uses the incompatible channel protocol version for registration", () => {
    expect(PROTOCOL_VERSION).toBe(3);
    expect(isAgentCard(card)).toBe(true);
    expect(parseRpcRequest({ op: "register", protocol_version: PROTOCOL_VERSION, card })).toEqual({
      ok: true,
      request: { op: "register", protocol_version: PROTOCOL_VERSION, card },
    });
  });

  it("parses direct, group any, and explicit all requests", () => {
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "request", to: ["agent-b"], body: "check" })).toMatchObject({ ok: true, request: { kind: "request", to: ["agent-b"] } });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "request", to: ["agent-b", "agent-c"], body: "check", response_policy: "all" })).toMatchObject({ ok: true, request: { response_policy: "all" } });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "request", to: ["agent-b"], body: "check", response_policy: "any" })).toEqual({ ok: false, error: "a single-recipient request must use response_policy all" });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "note", to: ["agent-b"], body: "done" })).toMatchObject({ ok: true, request: { kind: "note" } });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "core", kind: "notification", to: ["agent-a"], channel_id: ulid(), schema: "onclave.vault.notification.v1", body: "completed" })).toMatchObject({ ok: true, request: { kind: "notification", to: ["agent-a"] } });
  });

  it("accepts advanced responses but rejects invalid combinations before publication", () => {
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-b", kind: "response", channel_id: ulid(), in_reply_to: ulid(), body: "answer" })).toMatchObject({ ok: true });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "request", to: ["agent-b"], body: "bad", task_id: ulid() })).toEqual({ ok: false, error: "channel messages do not accept task_id, context_id, or timeout_ms" });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "note", to: ["agent-b"], response_policy: "all", body: "bad" })).toEqual({ ok: false, error: "note cannot carry response correlation or policy" });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "core", kind: "notification", to: ["agent-a"], response_policy: "all", body: "bad" })).toEqual({ ok: false, error: "notification cannot carry response correlation or policy" });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "core", kind: "notification", body: "bad" })).toEqual({ ok: false, error: "notification requires to as a non-empty list" });
    expect(parseRpcRequest({ op: "post_channel_message", sender_instance_id: "agent-a", kind: "response", body: "bad" })).toEqual({ ok: false, error: "response requires in_reply_to outside an active request" });
  });

  it("keeps agent listing, task operations, and transport validation", () => {
    expect(isAgentCard({ ...card, transport: "wss" })).toBe(false);
    expect(parseRpcRequest({ op: "list_agents" })).toEqual({ ok: true, request: { op: "list_agents" } });
    expect(parseRpcRequest({ op: "get_channel", channel_id: ulid() })).toMatchObject({ ok: true });
    expect(parseRpcRequest({ op: "channel_messages", channel_id: ulid(), after_sequence: 0, limit: 10 })).toMatchObject({ ok: true });
  });
});
