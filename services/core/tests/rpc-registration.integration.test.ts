import { mkdtemp, rm } from "node:fs/promises";
import { connect, type Channel } from "amqplib";
import { afterEach, describe, expect, it } from "vitest";
import { EXCHANGE_AGENTS, PROTOCOL_VERSION, agentQueueName, ulid } from "@onclave/envelope";
import type { CoreConfig } from "../src/config";
import { handleRpcRequest, type CoreServices } from "../src/rpc";
import { Registry } from "../src/registry";
import { join } from "node:path";
import { tmpdir } from "node:os";

const amqpUrl = process.env.ONCLAVE_TEST_AMQP_URL ?? "";
const describeIntegration = amqpUrl === "" ? describe.skip : describe;

describeIntegration("registration broker channel isolation", () => {
  let connection: Awaited<ReturnType<typeof connect>>;
  let coreChannel: Channel;
  let queue: string;
  let dataDir: string;

  afterEach(async () => {
    if (queue !== undefined) await coreChannel.deleteQueue(queue).catch(() => undefined);
    await connection?.close().catch(() => undefined);
    if (dataDir !== undefined) await rm(dataDir, { recursive: true, force: true });
  });

  it("contains an inequivalent queue declaration channel-close to one registration", async () => {
    connection = await connect(amqpUrl);
    coreChannel = await connection.createChannel();
    await coreChannel.assertExchange(EXCHANGE_AGENTS, "direct", { durable: true });
    const agentId = `registration-${ulid().toLowerCase()}`;
    queue = agentQueueName(agentId);
    await coreChannel.assertQueue(queue, { durable: true, arguments: { "x-message-ttl": 1 } });

    dataDir = await mkdtemp(join(tmpdir(), "onclave-rpc-registration-integration-"));
    const registry = new Registry({ path: join(dataDir, "registry.json"), staleMs: 60_000 });
    const services: CoreServices = {
      config: {
        amqpUrl,
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
      } satisfies CoreConfig,
      registry,
      createRegistrationChannel: () => connection.createChannel(),
      audit: async () => undefined,
    };

    await expect(handleRpcRequest(services, coreChannel, {
      op: "register",
      protocol_version: PROTOCOL_VERSION,
      card: { agent_id: agentId, name: "Registration test", host: "test", transport: "amqp" },
    })).rejects.toThrow();

    expect(registry.get(agentId)).toBeUndefined();
    const healthQueue = `registration-health-${ulid().toLowerCase()}`;
    await expect(coreChannel.assertQueue(healthQueue, { durable: true })).resolves.toBeDefined();
    await coreChannel.deleteQueue(healthQueue);
  });
});
