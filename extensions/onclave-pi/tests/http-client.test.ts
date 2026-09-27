import { describe, expect, it, vi } from "vitest";
import { createChannelMessage, createTask, createTaskStatusEvent, ulid, type TaskStatusEvent } from "@onclave/envelope";
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

describe("Onclave HTTP channel boundary", () => {
  it("posts a model-sized draft and parses the canonical core response", async () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "request", origin: { instance_id: "origin", name: "Origin", host: "host" }, participants: ["origin", "receiver"], body: "check" });
    const fetchFn = vi.fn(async (_input, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({ kind: "request", to: ["receiver"], body: "check" });
      return Response.json({ ok: true, message_id: message.message_id, channel_id: message.channel_id, sequence: message.sequence, message, duplicate: false }, { status: 202 });
    });
    const result = await client(fetchFn).postChannelMessage({ kind: "request", to: ["receiver"], body: "check" });
    expect(result).toMatchObject({ message, duplicate: false });
  });

  it("reads the current live peer count from empty and delivered poll responses", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204, headers: { "x-onclave-live-peers": "3" } }));
    const http = client(fetchFn);
    expect(await http.next("receiver", 25_000)).toBeUndefined();
    expect(http.getLivePeerCount()).toBe(3);

    fetchFn.mockResolvedValueOnce(Response.json({ delivery_id: "delivery", kind: "task-status", status: status() }, { headers: { "x-onclave-live-peers": "1" } }));
    await http.next("receiver", 25_000);
    expect(http.getLivePeerCount()).toBe(1);
  });

  it("ignores malformed live peer counts", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 204, headers: { "x-onclave-live-peers": "-1" } }));
    const http = client(fetchFn);
    expect(await http.next("receiver", 0)).toBeUndefined();
    expect(http.getLivePeerCount()).toBeUndefined();
  });

  it("parses a channel delivery through the shared validator", async () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "note", origin: { instance_id: "origin", name: "Origin", host: "host" }, participants: ["origin", "receiver"], body: "done" });
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "message", message }));
    const delivery = await client(fetchFn).next("receiver", 0);
    expect(delivery).toEqual({ deliveryId: "delivery", kind: "message", message });
  });

  it("keeps independent task status parsing separate", async () => {
    const event = status();
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "task-status", status: event }));
    const delivery = await client(fetchFn).next("receiver", 0);
    expect(delivery).toEqual({ deliveryId: "delivery", kind: "task-status", status: event });
  });

  it("renders structured validation details in HTTP errors", async () => {
    const fetchFn = vi.fn(async () => Response.json({ detail: [
      { type: "missing", loc: ["body", "notify_agent_id"], msg: "Field required", input: { secret: "must-not-leak" } },
      { type: "value_error", loc: ["body", "schema"], msg: "Unsupported schema" },
    ] }, { status: 422 }));
    await expect(client(fetchFn).postChannelMessage({ kind: "request", to: ["receiver"], body: "check" }))
      .rejects.toThrow("Onclave API request failed (422): body.notify_agent_id: Field required [missing]; body.schema: Unsupported schema [value_error]");
    await expect(client(fetchFn).postChannelMessage({ kind: "request", to: ["receiver"], body: "check" }))
      .rejects.not.toThrow("must-not-leak");
  });

  it("rejects incompatible or malformed deliveries before handling them", async () => {
    const message = createChannelMessage({ channel_id: ulid(), kind: "note", origin: { instance_id: "origin", name: "Origin", host: "host" }, participants: ["origin", "receiver"], body: "done" });
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "message", message: { ...message, protocol_version: 1 } }));
    await expect(client(fetchFn).next("receiver", 0)).rejects.toThrow("invalid channel message");
  });

  it("rejects malformed independent task status instead of coercing it", async () => {
    const event = status();
    const fetchFn = vi.fn(async () => Response.json({ delivery_id: "delivery", kind: "task-status", status: { ...event, state: "not-a-state" } }));
    await expect(client(fetchFn).next("receiver", 0)).rejects.toThrow("invalid task status");
  });
});
