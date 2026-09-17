import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Channel as AmqpChannel } from "amqplib";
import { CHANNEL_PROTOCOL_VERSION, LEGACY_CHANNEL_PROTOCOL_VERSION, type AgentCard, ulid } from "@onclave/envelope";
import { ChannelStore } from "../src/channel-store";
import { handleRpcRequest } from "../src/rpc";
import { Registry } from "../src/registry";
import type { CoreConfig } from "../src/config";

const config = (dir: string): CoreConfig => ({
  amqpUrl: "amqp://test",
  httpPort: 0,
  dataDir: dir,
  registryPath: join(dir, "registry.json"),
  a2aStatePath: join(dir, "tasks.json"),
  channelStatePath: join(dir, "channels.json"),
  auditPath: join(dir, "audit.jsonl"),
  trustDir: join(dir, "trust"),
  queueTtlMs: 60_000,
  queueMaxLength: 1000,
  heartbeatStaleMs: 60_000,
  budgetLimits: { maxExchanges: 16, maxTotalTokens: 100 },
  connectRetryBaseMs: 10,
  connectRetryMaxMs: 50,
});

const originA = { instance_id: "pi-a", name: "A", host: "host-a" };
const originB = { instance_id: "pi-b", name: "B", host: "host-b" };
const originC = { instance_id: "pi-c", name: "C", host: "host-c" };

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "onclave-channel-store-"));
  return { dir, path: join(dir, "channels.json") };
}

function fakeChannel() {
  return {
    publish: vi.fn(() => true),
    assertQueue: vi.fn(async () => undefined),
    bindQueue: vi.fn(async () => undefined),
  } as unknown as AmqpChannel;
}

async function registeredServices(dir: string) {
  const cards: AgentCard[] = [originA, originB, originC].map((card) => ({ agent_id: card.instance_id, name: card.name, host: card.host, transport: "amqp" as const }));
  const registry = new Registry({ path: join(dir, "registry.json"), staleMs: 60_000 });
  for (const [index, card] of cards.entries()) await registry.register(card, `key-${index}`);
  const channels = new ChannelStore({ path: join(dir, "channels.json") });
  const services = { config: config(dir), registry, channels, audit: vi.fn(async () => undefined) };
  return { services, channels, registry };
}

describe("ChannelStore", () => {
  it("reuses exact participant sets and serializes sequence assignment", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new ChannelStore({ path });
      const first = await store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "first" });
      const [second, third] = await Promise.all([
        store.post({ origin: originA, kind: "note", to: ["pi-b"], body: "second" }),
        store.post({ origin: originB, kind: "note", to: ["pi-a"], body: "third" }),
      ]);
      expect(second.message.channel_id).toBe(first.message.channel_id);
      expect(third.message.channel_id).toBe(first.message.channel_id);
      expect([second.message.sequence, third.message.sequence].sort((a, b) => a - b)).toEqual([2, 3]);
      expect(store.listMessages(first.message.channel_id).map((message) => message.sequence)).toEqual([1, 2, 3]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("computes any/all satisfaction, counts responders once, and preserves history", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new ChannelStore({ path });
      const anyRequest = await store.post({ origin: originA, kind: "request", to: ["pi-b", "pi-c"], body: "either report" });
      const firstResponse = await store.post({ origin: originB, kind: "response", channel_id: anyRequest.message.channel_id, in_reply_to: anyRequest.message.message_id, body: "B" });
      expect(firstResponse.satisfaction).toMatchObject({ response_policy: "any", responders_received: ["pi-b"], state: "satisfied" });
      const duplicateResponder = await store.post({ origin: originB, kind: "response", channel_id: anyRequest.message.channel_id, in_reply_to: anyRequest.message.message_id, body: "B again" });
      expect(duplicateResponder.satisfaction?.responders_received).toEqual(["pi-b"]);
      const requesterResponse = await store.post({ origin: originA, kind: "response", channel_id: anyRequest.message.channel_id, in_reply_to: anyRequest.message.message_id, body: "unexpected requester response" });
      expect(requesterResponse.satisfaction?.responders_received).toEqual(["pi-b"]);

      const allRequest = await store.post({ origin: originA, kind: "request", to: ["pi-b", "pi-c"], response_policy: "all", body: "both report" });
      const bResponse = await store.post({ origin: originB, kind: "response", channel_id: allRequest.message.channel_id, in_reply_to: allRequest.message.message_id, body: "B" });
      expect(bResponse.satisfaction?.state).toBe("open");
      const cResponse = await store.post({ origin: originC, kind: "response", channel_id: allRequest.message.channel_id, in_reply_to: allRequest.message.message_id, body: "C" });
      expect(cResponse.satisfaction).toMatchObject({ response_policy: "all", responders_received: ["pi-b", "pi-c"], state: "satisfied" });
      expect(store.listMessages(anyRequest.message.channel_id)).toHaveLength(7);
      expect(store.getRequest(anyRequest.message.message_id)?.state).toBe("satisfied");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bounds open request state while retaining linkage beyond message history", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new ChannelStore({ path, maxMessages: 1, maxRequests: 1 });
      const request = await store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "first" });
      await store.post({ origin: originA, kind: "note", to: ["pi-b"], body: "history moves on" });
      await expect(store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "blocked while first is open" })).rejects.toThrow("capacity");
      const response = await store.post({ origin: originB, kind: "response", channel_id: request.message.channel_id, in_reply_to: request.message.message_id, body: "done" });
      expect(response.satisfaction?.state).toBe("satisfied");
      const next = await store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "second" });
      expect(next.message.sequence).toBe(4);
      const restored = new ChannelStore({ path, maxMessages: 1, maxRequests: 1 });
      expect(await restored.load()).toEqual({ channels: 1, messages: 1, requests: 1 });
      expect(restored.getRequest(request.message.message_id)?.state).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("migrates validated protocol-v2 state and persists protocol-v3 without losing history", async () => {
    const { dir, path } = await fixture();
    try {
      const source = new ChannelStore({ path });
      const request = await source.post({ origin: originA, kind: "request", to: ["pi-b"], body: "restore me" });
      await source.post({ origin: originB, kind: "note", to: ["pi-a"], body: "historical note" });
      const current = JSON.parse(await readFile(path, "utf8")) as {
        protocol_version: number;
        channels: Array<{ protocol_version: number; messages: Array<{ protocol_version: number }>; requests: Array<{ protocol_version: number }> }>;
      };
      const legacy = {
        ...current,
        protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION,
        channels: current.channels.map((channel) => ({
          ...channel,
          protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION,
          messages: channel.messages.map((message) => ({ ...message, protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION })),
          requests: channel.requests.map((requestState) => ({ ...requestState, protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION })),
        })),
      };
      await writeFile(path, JSON.stringify(legacy), "utf8");

      const restored = new ChannelStore({ path });
      expect(await restored.load()).toEqual({ channels: 1, messages: 2, requests: 1 });
      expect(restored.listMessages(request.message.channel_id).map((message) => message.body)).toEqual(["restore me", "historical note"]);
      const persisted = JSON.parse(await readFile(path, "utf8")) as typeof current;
      expect(persisted.protocol_version).toBe(CHANNEL_PROTOCOL_VERSION);
      expect(persisted.channels[0]?.protocol_version).toBe(CHANNEL_PROTOCOL_VERSION);
      expect(persisted.channels[0]?.messages.every((message) => message.protocol_version === CHANNEL_PROTOCOL_VERSION)).toBe(true);
      expect(persisted.channels[0]?.requests.every((requestState) => requestState.protocol_version === CHANNEL_PROTOCOL_VERSION)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects protocol-v2 state containing the new notification kind", async () => {
    const { dir, path } = await fixture();
    try {
      const source = new ChannelStore({ path });
      await source.post({ origin: originA, kind: "note", to: ["pi-b"], body: "legacy" });
      const current = JSON.parse(await readFile(path, "utf8")) as { channels: Array<{ messages: Array<Record<string, unknown>> }> };
      const legacy = {
        protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION,
        channels: current.channels.map((channel) => ({
          ...channel,
          protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION,
          messages: channel.messages.map((message) => ({ ...message, protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION, kind: "notification" })),
        })),
      };
      await writeFile(path, JSON.stringify(legacy), "utf8");
      await expect(new ChannelStore({ path }).load()).rejects.toThrow("invalid channel state file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("persists canonical state and restores sequence and response linkage", async () => {
    const { dir, path } = await fixture();
    try {
      const store = new ChannelStore({ path });
      const request = await store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "restore me", idempotency_key: "post-1" });
      const duplicate = await store.post({ origin: originA, kind: "request", to: ["pi-b"], body: "different retry", idempotency_key: "post-1" });
      expect(duplicate.duplicate).toBe(true);
      expect(duplicate.message.message_id).toBe(request.message.message_id);
      const response = await store.post({ origin: originB, kind: "response", channel_id: request.message.channel_id, in_reply_to: request.message.message_id, body: "restored answer" });
      const restored = new ChannelStore({ path });
      expect(await restored.load()).toEqual({ channels: 1, messages: 2, requests: 1 });
      expect(restored.getRequest(request.message.message_id)).toMatchObject({ state: "satisfied", responders_received: ["pi-b"] });
      const note = await restored.post({ origin: originA, kind: "note", to: ["pi-b"], body: "after restart" });
      expect(note.message.sequence).toBe(response.message.sequence + 1);
      expect(JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"))).toMatchObject({ protocol_version: CHANNEL_PROTOCOL_VERSION });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("channel RPC aggregate boundary", () => {
  it("rejects protocol-v2 live registrations after the channel version bump", async () => {
    const { dir } = await fixture();
    try {
      const { services } = await registeredServices(dir);
      const response = await handleRpcRequest(services, fakeChannel(), {
        op: "register",
        protocol_version: LEGACY_CHANNEL_PROTOCOL_VERSION,
        card: { agent_id: "new-agent", name: "New Agent", host: "host-new", transport: "amqp" },
      });
      expect(response).toEqual({ ok: false, error: "protocol_version_mismatch", expected: CHANNEL_PROTOCOL_VERSION });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("authenticates participants, persists before fan-out, and fans out to durable mailboxes", async () => {
    const { dir } = await fixture();
    try {
      const { services } = await registeredServices(dir);
      const channel = fakeChannel();
      const result = await handleRpcRequest(services, channel, { op: "post_channel_message", sender_instance_id: "pi-a", kind: "request", to: ["pi-b", "pi-c"], body: "validate" }, "key-0");
      expect(result).toMatchObject({ ok: true, message: { kind: "request", participants: ["pi-a", "pi-b", "pi-c"], response_policy: "any" } });
      expect(channel.publish).toHaveBeenCalledTimes(3);
      const firstPublish = (channel.publish as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      expect((firstPublish?.[3] as { headers?: Record<string, unknown> } | undefined)?.headers).not.toHaveProperty("response_satisfaction");
      expect(await services.channels?.load()).toMatchObject({ channels: 1, messages: 1, requests: 1 });
      await expect(handleRpcRequest(services, channel, { op: "post_channel_message", sender_instance_id: "pi-a", kind: "note", to: ["pi-b"], body: "forged" }, "key-other")).rejects.toThrow("different key");
      expect(channel.publish).toHaveBeenCalledTimes(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
