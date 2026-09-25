import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "amqplib";
import { PROTOCOL_VERSION } from "@onclave/envelope";
import type { CoreConfig } from "../src/config";
import { handleRpcRequest, type CoreServices } from "../src/rpc";
import { Registry } from "../src/registry";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "onclave-rpc-registration-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const config = (dataDir: string): CoreConfig => ({
  amqpUrl: "amqp://test",
  httpPort: 0,
  dataDir,
  registryPath: join(dataDir, "registry.json"),
  auditPath: join(dataDir, "audit.jsonl"),
  trustDir: join(dataDir, "trust"),
  queueTtlMs: 60_000,
  queueMaxLength: 1000,
  heartbeatStaleMs: 60_000,
  budgetLimits: { maxExchanges: 16, maxTotalTokens: 100 },
  connectRetryBaseMs: 10,
  connectRetryMaxMs: 50,
});

function makeChannel() {
  const channel = {
    assertQueue: vi.fn(async () => undefined),
    bindQueue: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    on: vi.fn(),
    once: vi.fn(),
  };
  return channel as unknown as Channel & typeof channel;
}

function registrationServices(createRegistrationChannel: () => Promise<Channel>) {
  const registry = new Registry({ path: join(dir, "registry.json"), staleMs: 60_000 });
  const services: CoreServices = {
    config: config(dir),
    registry,
    createRegistrationChannel,
    audit: vi.fn(async () => undefined),
  };
  return { services, registry };
}

const registerRequest = {
  op: "register" as const,
  protocol_version: PROTOCOL_VERSION,
  card: { agent_id: "agent-a", name: "Agent A", host: "host-a", transport: "amqp" as const },
};

describe("agent RPC registration broker isolation", () => {
  it("does not update registry and closes the disposable channel when queue setup fails", async () => {
    const registrationChannel = makeChannel();
    registrationChannel.assertQueue.mockRejectedValue(new Error("channel closed"));
    const { services, registry } = registrationServices(async () => registrationChannel);

    await expect(handleRpcRequest(services, makeChannel(), registerRequest)).rejects.toThrow("channel closed");

    expect(registry.get("agent-a")).toBeUndefined();
    expect(registrationChannel.bindQueue).not.toHaveBeenCalled();
    expect(registrationChannel.close).toHaveBeenCalledOnce();
  });

  it("sets up queue and binding before updating registry, then closes the disposable channel", async () => {
    const registrationChannel = makeChannel();
    const { services, registry } = registrationServices(async () => registrationChannel);
    registrationChannel.assertQueue.mockImplementation(async () => {
      expect(registry.get("agent-a")).toBeUndefined();
    });
    registrationChannel.bindQueue.mockImplementation(async () => {
      expect(registry.get("agent-a")).toBeUndefined();
    });

    const result = await handleRpcRequest(services, makeChannel(), registerRequest);

    expect(result).toMatchObject({ ok: true, agent: { agent_id: "agent-a" } });
    expect(registry.get("agent-a")).toBeDefined();
    expect(registrationChannel.close).toHaveBeenCalledOnce();
  });
});
