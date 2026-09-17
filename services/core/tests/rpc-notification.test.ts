import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import type { Channel as AmqpChannel } from "amqplib";
import { CHANNEL_PROTOCOL_VERSION } from "@onclave/envelope";
import type { CoreConfig } from "../src/config";
import { ChannelStore } from "../src/channel-store";
import { postCoreChannelMessage, type CoreServices } from "../src/rpc";
import { Registry } from "../src/registry";

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

function fakeChannel() {
  return { publish: vi.fn(() => true) } as unknown as AmqpChannel;
}

describe("Core service-originated channel notifications", () => {
  it("persists and routes an idempotent notification without request state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "onclave-rpc-notification-"));
    try {
      const channels = new ChannelStore({ path: join(dir, "channels.json") });
      const services: CoreServices = {
        config: config(dir),
        registry: new Registry({ path: join(dir, "registry.json"), staleMs: 60_000 }),
        channels,
        audit: vi.fn(async () => undefined),
      };
      const channel = fakeChannel();
      const input = {
        kind: "notification" as const,
        to: ["pi-agent"],
        body: JSON.stringify({ schema: "onclave.job.terminal.v1", event: "job_terminal", trust: "untrusted_data" }),
        schema: "onclave.job.terminal.v1",
        idempotency_key: "job:job-1:terminal:pi-agent",
      };

      const first = await postCoreChannelMessage(services, channel, input);
      const duplicate = await postCoreChannelMessage(services, channel, input);

      expect(first.message_id).toBe(duplicate.message_id);
      expect(first.kind).toBe("notification");
      expect(first.protocol_version).toBe(CHANNEL_PROTOCOL_VERSION);
      expect(channel.publish).toHaveBeenCalledTimes(2);
      expect(channels.listRequests(first.channel_id)).toEqual([]);
      expect(channels.listMessages(first.channel_id)).toHaveLength(1);
      expect(JSON.parse(await readFile(join(dir, "channels.json"), "utf8"))).toMatchObject({
        protocol_version: CHANNEL_PROTOCOL_VERSION,
        channels: [{ requests: [] }],
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
