import { describe, expect, it } from "vitest";
import { agentQueueName, fromA2AMessage, fromA2ATaskStatus, toA2AMessagePublish, toA2ATaskStatusPublish } from "../src/amqp";
import { createMessage, createTask, createTaskStatusEvent, type A2AOrigin } from "../src/a2a";
import { ulid } from "../src/ulid";

const origin: A2AOrigin = { instance_id: "a", name: "A", host: "host" };
function consumed(spec: ReturnType<typeof toA2AMessagePublish>) { return { content: spec.content, properties: { ...spec.options } }; }

describe("A2A AMQP mapping", () => {
  it("round-trips a versioned message without legacy fields", () => {
    const message = createMessage({ type: "request", context_id: ulid(), origin, destination: "b", body: "hello" });
    const spec = toA2AMessagePublish(message);
    expect(spec.routingKey).toBe("b");
    expect(spec.options.replyTo).toBe(agentQueueName("a"));
    expect(fromA2AMessage(consumed(spec))).toEqual({ ok: true, message });
    expect(spec.options.headers).not.toHaveProperty("performative");
  });

  it("rejects incompatible protocol versions explicitly", () => {
    const message = createMessage({ type: "inform", context_id: ulid(), origin, destination: "b", body: "hello" });
    const spec = toA2AMessagePublish(message);
    spec.options.headers["x-onclave-a2a-v"] = 2;
    expect(fromA2AMessage(consumed(spec))).toEqual({ ok: false, error: "protocol_version_mismatch" });
  });

  it("maps task status events to the origin queue", () => {
    const task = createTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
    const event = createTaskStatusEvent(task, "working");
    const spec = toA2ATaskStatusPublish(event);
    expect(spec.routingKey).toBe("a");
    expect(fromA2ATaskStatus({ content: spec.content, properties: { ...spec.options } })).toMatchObject({ ok: true, event: { task_id: task.task_id, state: "working" } });
  });

  it.each([
    ["body", { body: 42 }],
    ["usage", { usage: { input_tokens: "1", output_tokens: 0 } }],
    ["message_id", { message_id: "not-a-ulid" }],
  ])("rejects malformed task status %s instead of coercing it", (_field, override) => {
    const task = createTask({ contextId: ulid(), originInstanceId: "a", assigneeInstanceId: "b" });
    const event = createTaskStatusEvent(task, "working");
    const spec = toA2ATaskStatusPublish({ ...event, ...override } as typeof event);
    expect(fromA2ATaskStatus({ content: spec.content, properties: { ...spec.options } })).toMatchObject({ ok: false });
  });
});
