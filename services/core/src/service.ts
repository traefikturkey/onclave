import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import { AgentDeliveryService } from "./agent-delivery";
import { startBroker, type BrokerClient } from "./broker";
import { appendAuditEvent, type AuditEventName, type AuditMetadata } from "./audit";
import { loadCoreConfig, redactAmqpUrl, type CoreConfig } from "./config";
import { ConversationStore } from "./conversations";
import { startDeadLetterConsumer } from "./dead-letter";
import { startHealthServer } from "./health";
import { createVaultHttpServer } from "./vault/http";
import { createAgentRouteHandlers } from "./vault/agent-routes";
import { createVaultRouteHandlers } from "./vault/routes";
import { createVaultService, type VaultService } from "./vault/vault-service";
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

  const deliveries = new AgentDeliveryService();
  const broker = startBroker({
    amqpUrl: config.amqpUrl,
    retryBaseMs: config.connectRetryBaseMs,
    retryMaxMs: config.connectRetryMaxMs,
    onChannelReady: async (channel) => {
      await startRpcServer(services, channel);
      await startDeadLetterConsumer(services, channel);
      deliveries.onChannelReady(channel);
    },
  });

  let vault: VaultService | undefined;
  let healthServer: Server | undefined;
  if (options.withHealthServer !== false) {
    if (config.vault === undefined) {
      healthServer = startHealthServer(config.httpPort, broker);
    } else {
      vault = await createVaultService(config.vault);
      healthServer = createVaultHttpServer({
        keyStore: vault.keyStore,
        handlers: {
          ...createVaultRouteHandlers({
            ...vault,
            health: () => {
              const status = broker.status();
              // Broker state is diagnostic only: the deployment gate requires a running HTTP service.
              return {
                status: "ok",
                git_sha: process.env.GIT_SHA ?? "unknown",
                build_date: process.env.BUILD_DATE ?? "unknown",
                app_version: process.env.ONCLAVE_VAULT_APP_VERSION ?? "0.1.0",
                broker: {
                  connected: status.connected,
                  topologyDeclared: status.topologyDeclared,
                  ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
                },
              };
            },
          }),
          ...createAgentRouteHandlers({
            services,
            channel: () => broker.channel(),
            deliveries,
          }),
        },
      });
      healthServer.listen(config.httpPort, () => {
        log("info", "health.listening", { port: config.httpPort });
      });
    }
  }

  await audit("core_start", { amqp_url: redactAmqpUrl(config.amqpUrl) });

  return {
    config,
    broker,
    healthServer,
    services,
    stop: async () => {
      healthServer?.close();
      deliveries.close();
      await vault?.close();
      await broker.close();
      await audit("core_stop", {});
    },
  };
}
