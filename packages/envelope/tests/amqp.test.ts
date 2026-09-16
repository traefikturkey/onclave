import { describe, expect, it } from "vitest";
import { agentQueueName, fromChannelMessage, fromA2ATaskStatus, toChannelMessagePublish, toTaskStatusPublish } from "../src/amqp";
import { CHANNEL_PROTOCOL_VERSION, createChannelMessage, createTask, createTaskStatusEvent, type A2AOrigin, type ChannelSatisfaction } from "../src/a2a";
import { ulid } from "../src/ulid";

const origin: A2AOrigin = { instance_id: "a", name: "A", host: "host" };
function consumed(spec: ReturnType<typeof toChannelMessagePublish>) { return { content: spec.content, properties: { ...spec.options } }; }

describe("channel AMQP mapping", () => {
  it("round-trips one canonical channel event to a participant mailbox", () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "request", origin, participants: ["a", "b"], body: "hello" });
    const spec = toChannelMessagePublish(message, "b");
    expect(spec.routingKey).toBe("b");
    expect(spec.options.replyTo).toBe(agentQueueName("a"));
    expect(spec.options.correlationId).toBe(message.channel_id);
    expect(spec.options.headers["x-onclave-channel-v"]).toBe(CHANNEL_PROTOCOL_VERSION);
    expect(fromChannelMessage(consumed(spec))).toEqual({ ok: true, message });
    expect(spec.options.headers).not.toHaveProperty("performative");
  });

  it("maps the same event to every participant without a channel exchange", () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "note", origin, participants: ["a", "b", "c"], body: "hello" });
    const specs = ["a", "b", "c"].map((recipient) => toChannelMessagePublish(message, recipient));
    expect(specs.map((spec) => spec.routingKey)).toEqual(["a", "b", "c"]);
    expect(new Set(specs.map((spec) => spec.options.messageId))).toEqual(new Set([message.message_id]));
  });

  it("round-trips objective response satisfaction with a response delivery", () => {
    const request = createChannelMessage({ channel_id: ulid(), kind: "request", origin, participants: ["a", "b"], body: "report" });
    const response = createChannelMessage({ channel_id: request.channel_id, kind: "response", origin: { instance_id: "b", name: "B", host: "host-b" }, participants: request.participants, in_reply_to: request.message_id, body: "done" });
    const satisfaction: ChannelSatisfaction = {
      channel_id: request.channel_id,
      request_message_id: request.message_id,
      response_requested_from: ["b"],
      response_policy: "all",
      responders_received: ["b"],
      state: "satisfied",
    };
    const spec = toChannelMessagePublish(response, "a", satisfaction);
    expect(spec.options.headers.response_satisfaction).toBe(JSON.stringify(satisfaction));
    expect(fromChannelMessage(consumed(spec))).toEqual({ ok: true, message: response, satisfaction });
  });

  it("rejects incompatible channel protocol versions explicitly", () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "note", origin, participants: ["a", "b"], body: "hello" });
    const spec = toChannelMessagePublish(message, "b");
    spec.options.headers["x-onclave-channel-v"] = 1;
    expect(fromChannelMessage(consumed(spec))).toEqual({ ok: false, error: "protocol_version_mismatch" });
  });

  it("keeps independent task status mapping separate", () => {
    const task = createTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
    const event = createTaskStatusEvent(task, "working");
    const spec = toTaskStatusPublish(event);
    expect(spec.routingKey).toBe("a");
    expect(fromA2ATaskStatus({ content: spec.content, properties: { ...spec.options } })).toMatchObject({ ok: true, event: { task_id: task.task_id, state: "working" } });
  });

  it("rejects malformed independent task status instead of coercing it", () => {
    const task = createTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
    const event = createTaskStatusEvent(task, "working");
    const spec = toTaskStatusPublish({ ...event, message_id: "not-a-ulid" });
    expect(fromA2ATaskStatus({ content: spec.content, properties: { ...spec.options } })).toMatchObject({ ok: false });
  });
});
