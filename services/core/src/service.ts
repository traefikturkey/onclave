import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { startBroker, type BrokerClient } from "./broker";
import { appendAuditEvent, type AuditEventName, type AuditMetadata } from "./audit";
import { loadCoreConfig, redactAmqpUrl, type CoreConfig } from "./config";
import { ConversationStore } from "./conversations";
import { startDeadLetterConsumer } from "./dead-letter";
import { startHealthServer } from "./health";
import { log } from "./log";
import { Registry } from "./registry";
import { startRpcServer, type CoreServices } from "./rpc";
import { loadTrustEntries } from "./trust";

export type CoreRuntime = {
  config: CoreConfig;
  broker: BrokerClient;
  healthServer: Server | undefined;
  services: CoreServices;
  stop: () => Promise<void>;
};

export type StartCoreOptions = {
  config?: CoreConfig;
  withHealthServer?: boolean;
};

export async function startCore(options: StartCoreOptions = {}): Promise<CoreRuntime> {
  const config = options.config ?? loadCoreConfig();
  await mkdir(config.dataDir, { recursive: true });

  const registry = new Registry({
    path: config.registryPath,
    staleMs: config.heartbeatStaleMs,
  });
  const conversations = new ConversationStore({
    path: config.conversationsPath,
    limits: config.budgetLimits,
  });
  const audit = (event: AuditEventName, metadata: AuditMetadata = {}) =>
    appendAuditEvent(config.auditPath, event, metadata);

  const services: CoreServices = { config, registry, conversations, audit };

  const restoredAgents = await registry.load();
  const restoredConversations = await conversations.load();
  const trustEntries = await loadTrustEntries(config.trustDir);
  await audit("trust_loaded", { entries: trustEntries.length });
  log("info", "core.state_loaded", {
    agents: restoredAgents,
    conversations: restoredConversations,
    trustEntries: trustEntries.length,
  });

  const broker = startBroker({
    amqpUrl: config.amqpUrl,
    retryBaseMs: config.connectRetryBaseMs,
    retryMaxMs: config.connectRetryMaxMs,
    onChannelReady: async (channel) => {
      await startRpcServer(services, channel);
      await startDeadLetterConsumer(services, channel);
    },
  });

  const healthServer =
    options.withHealthServer === false ? undefined : startHealthServer(config.httpPort, broker);

  await audit("core_start", { amqp_url: redactAmqpUrl(config.amqpUrl) });

  return {
    config,
    broker,
    healthServer,
    services,
    stop: async () => {
      healthServer?.close();
      await broker.close();
      await audit("core_stop", {});
    },
  };
}
