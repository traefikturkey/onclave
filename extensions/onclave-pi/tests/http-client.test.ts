import { describe, expect, it, vi } from "vitest";
import { createTask, createTaskStatusEvent, ulid, type TaskStatusEvent } from "@onclave/envelope";
import { OnclaveHttpClient } from "../src/lib/http-client";

function status(): TaskStatusEvent {
  const task = createTask({ contextId: ulid(), originInstanceId: "origin", assigneeInstanceId: "receiver" });
  return createTaskStatusEvent(task, "working", { destination: "origin" });
}

function client(fetchFn: (input: string, init?: RequestInit) => Promise<Response>) {
  return new OnclaveHttpClient({
    apiBase: "https://onclave.example",
    signer: { keyId: "test", signRequest: vi.fn(() => ({})) },
    fetchFn,
  });
}

describe("Onclave HTTP task-status boundary", () => {
  it("parses a valid status through the shared envelope validator", async () => {
    const event = status();
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "task-status", status: event }));
    const delivery = await client(fetchFn).next("receiver", 0);
    expect(delivery).toEqual({ deliveryId: "delivery", kind: "task-status", status: event });
  });

  it.each([
    ["protocol version", { protocol_version: 2 }],
    ["state", { state: "not-a-state" }],
    ["identity", { origin_instance_id: "" }],
    ["timestamp", { occurred_at: "not-a-date" }],
    ["body", { body: 42 }],
    ["usage", { usage: { input_tokens: "1", output_tokens: 0 } }],
  ])("rejects invalid %s before delivery", async (_name, changes) => {
    const event = { ...status(), ...changes } as TaskStatusEvent;
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "task-status", status: event }));
    await expect(client(fetchFn).next("receiver", 0)).rejects.toThrow("invalid task status");
  });
});
