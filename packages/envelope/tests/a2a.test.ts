import { describe, expect, it } from "vitest";
import { createMessage, createTask, createTaskStatusEvent, parseMessage, transitionTask, type A2AOrigin } from "../src/a2a";
import { ulid } from "../src/ulid";

const origin: A2AOrigin = { instance_id: "instance-a", name: "A", host: "host-a" };
const contextId = ulid();

function message(type: "ask" | "request" | "inform" = "request") {
  return createMessage({ context_id: contextId, type, origin, destination: "instance-b", body: "hello" });
}

describe("A2A shared contract", () => {
  it("creates and parses versioned messages", () => {
    const created = message();
    expect(created.protocol_version).toBe(1);
    expect(parseMessage(created)).toEqual({ ok: true, value: created });
  });

  it("rejects incompatible versions and task-bearing informs", () => {
    expect(parseMessage({ ...message(), protocol_version: 2 })).toEqual({ ok: false, error: "protocol_version_mismatch" });
    expect(parseMessage({ ...message("inform"), task_id: ulid() })).toEqual({ ok: false, error: "inform cannot carry a task_id" });
  });

  it("covers every allowed and rejected task edge", () => {
    const allowed: Array<[string, string]> = [
      ["submitted", "working"], ["submitted", "input-required"], ["submitted", "failed"], ["submitted", "canceled"], ["submitted", "rejected"],
      ["working", "working"], ["working", "input-required"], ["working", "completed"], ["working", "failed"], ["working", "canceled"],
      ["input-required", "working"], ["input-required", "completed"], ["input-required", "failed"], ["input-required", "canceled"],
    ];
    for (const [from, to] of allowed) expect(transitionTask(from as never, to as never)).toEqual({ ok: true, state: to });
    for (const from of ["completed", "failed", "canceled", "rejected"] as const) {
      expect(transitionTask(from, "working")).toEqual({ ok: false, error: "terminal_immutable" });
    }
    expect(transitionTask("submitted", "completed")).toEqual({ ok: false, error: "illegal_transition" });
    expect(transitionTask("input-required", "submitted")).toEqual({ ok: false, error: "illegal_transition" });
  });

  it("creates submitted tasks and status events", () => {
    const task = createTask({ contextId, originInstanceId: "instance-a", assigneeInstanceId: "instance-b" });
    const event = createTaskStatusEvent(task, "working");
    expect(task.state).toBe("submitted");
    expect(event).toMatchObject({ task_id: task.task_id, context_id: contextId, state: "working", destination: "instance-a" });
  });
});
