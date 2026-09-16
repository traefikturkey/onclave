import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { CHANNEL_PROTOCOL_VERSION, ulid } from "@onclave/envelope";
import { ChannelStore } from "../src/channel-store";

/** The live broker suite remains a separate acceptance boundary. */
describe("channel protocol integration boundary", () => {
  it("uses the channel version and does not persist task linkage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onclave-channel-protocol-"));
    try {
      const store = new ChannelStore({ path: join(dir, "channels.json") });
      const result = await store.post({
        origin: { instance_id: "pi-a", name: "A", host: "host-a" },
        kind: "request",
        to: ["pi-b", "pi-c"],
        body: "identify the failure",
      });
      expect(result.message.protocol_version).toBe(CHANNEL_PROTOCOL_VERSION);
      expect(result.message.response_policy).toBe("any");
      expect(result.message).not.toHaveProperty("task_id");
      expect(store.getChannel(result.message.channel_id)?.requests[0]?.state).toBe("open");
      expect(store.listMessages(result.message.channel_id, 0)).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("restores a response obligation and counts one responder once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onclave-channel-protocol-"));
    try {
      const store = new ChannelStore({ path: join(dir, "channels.json") });
      const request = await store.post({ origin: { instance_id: "pi-a", name: "A", host: "host-a" }, kind: "request", to: ["pi-b", "pi-c"], body: "report" });
      await store.post({ origin: { instance_id: "pi-b", name: "B", host: "host-b" }, kind: "response", channel_id: request.message.channel_id, in_reply_to: request.message.message_id, body: "B done" });
      const restored = new ChannelStore({ path: join(dir, "channels.json") });
      await restored.load();
      const state = restored.getRequest(request.message.message_id);
      expect(state).toMatchObject({ state: "satisfied", responders_received: ["pi-b"], response_policy: "any" });
      const duplicateResponder = await restored.post({ origin: { instance_id: "pi-b", name: "B", host: "host-b" }, kind: "response", channel_id: request.message.channel_id, in_reply_to: request.message.message_id, body: "B again" });
      expect(duplicateResponder.satisfaction?.responders_received).toEqual(["pi-b"]);
      expect(restored.listMessages(request.message.channel_id, 0)).toHaveLength(3);
      expect(ulid()).toHaveLength(26);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
