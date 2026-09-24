import { mkdir } from "node:fs/promises";
import { ChannelStore } from "./channel-store";
import type { Server } from "node:http";
import { AgentDeliveryService } from "./agent-delivery";
import { startBroker, type BrokerClient } from "./broker";
import { appendAuditEvent, type AuditEventName, type AuditMetadata } from "./audit";
import { loadCoreConfig, redactAmqpUrl, type CoreConfig } from "./config";
import { TaskStore } from "./tasks";
import { startDeadLetterConsumer } from "./dead-letter";
import { startHealthServer } from "./health";
import { createVaultHttpServer } from "./vault/http";
import { HttpError } from "./vault/errors";
import { createAgentRouteHandlers } from "./vault/agent-routes";
import { createVaultRouteHandlers } from "./vault/routes";
import { createVaultService, type VaultService } from "./vault/vault-service";
import type { JobNotificationDelivery } from "./vault/jobs";
import { log } from "./log";
import { Registry } from "./registry";
import { postCoreChannelMessage, startRpcServer, type CoreServices } from "./rpc";
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
  const tasks = new TaskStore({
    path: config.a2aStatePath ?? `${config.dataDir}/a2a-state-v1.json`,
    limits: { maxTotalTokens: config.budgetLimits.maxTotalTokens },
  });
  const channels = new ChannelStore({
    path: config.channelStatePath ?? `${config.dataDir}/channels-state-v2.json`,
  });
  const audit = (event: AuditEventName, metadata: AuditMetadata = {}) =>
    appendAuditEvent(config.auditPath, event, metadata);

  const services: CoreServices = { config, registry, tasks, channels, audit };

  const restoredAgents = await registry.load();
  const restoredTasks = await tasks.load();
  const restoredChannels = await channels.load();
  const trustEntries = await loadTrustEntries(config.trustDir);
  await audit("trust_loaded", { entries: trustEntries.length });
  log("info", "core.state_loaded", {
    agents: restoredAgents,
    a2aContexts: restoredTasks.contexts,
    a2aTasks: restoredTasks.tasks,
    a2aEvents: restoredTasks.events,
    channelCount: restoredChannels.channels,
    channelMessages: restoredChannels.messages,
    channelRequests: restoredChannels.requests,
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
  let transcriptFailure: { videoId: string; error: string } | undefined;
  if (options.withHealthServer !== false) {
    if (config.vault === undefined) {
      healthServer = startHealthServer(config.httpPort, broker);
    } else {
      const vaultConfig = config.vault;
      vault = await createVaultService(vaultConfig, {
        notify: async (agentId, delivery: JobNotificationDelivery) => {
          const channel = broker.channel();
          if (channel === undefined) throw new Error("Broker unavailable");
          await postCoreChannelMessage(services, channel, {
            kind: delivery.kind,
            to: [agentId],
            body: delivery.body,
            schema: delivery.schema,
            idempotency_key: delivery.idempotency_key,
          });
        },
      });
      healthServer = createVaultHttpServer({
        keyStore: vault.keyStore,
        handlers: {
          ...createVaultRouteHandlers({
            ...vault,
            authorizeNotificationAgent: (agentId, keyId) => {
              const agent = services.registry.get(agentId);
              if (agent === undefined) throw new HttpError(404, "Notification agent is not registered");
              if (keyId === undefined || agent.key_id !== keyId) throw new HttpError(403, "Notification agent is bound to a different key");
            },
            health: () => {
              const status = broker.status();
              // Broker state is diagnostic only: the deployment gate requires a running HTTP service.
              return {
                status: transcriptFailure === undefined ? "ok" : "degraded",
                ...(transcriptFailure === undefined ? {} : {
                  transcript: { status: "degraded", videoId: transcriptFailure.videoId, lastError: transcriptFailure.error },
                }),
                git_sha: process.env.GIT_SHA ?? "unknown",
                build_date: process.env.BUILD_DATE ?? "unknown",
                app_version: vaultConfig.appVersion,
                broker: {
                  connected: status.connected,
                  topologyDeclared: status.topologyDeclared,
                  ...(status.lastError === undefined ? {} : { lastError: status.lastError }),
                },
              };
            },
            onTranscriptFailure: (videoId, error) => {
              transcriptFailure ??= { videoId, error: error.message };
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
