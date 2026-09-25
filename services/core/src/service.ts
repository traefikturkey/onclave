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
import { createObservability } from "./observability";
import { createVaultHttpServer } from "./vault/http";
import { HttpError } from "./vault/errors";
import { createAgentRouteHandlers } from "./vault/agent-routes";
import { createVaultRouteHandlers } from "./vault/routes";
import { safeTranscriptFailure, TranscriptHealthTracker } from "./vault/transcript-health";
import { createVaultService, type VaultService } from "./vault/vault-service";
import { YouTubeTranscriptService } from "./vault/youtube-transcript";
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

async function waitForListening(server: Server): Promise<void> {
  if (server.listening) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const onListening = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    server.once("listening", onListening);
    server.once("error", onError);
  });
}

async function closeHttpServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  });
}

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
  const observability = createObservability();
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
  services.createRegistrationChannel = () => broker.createRegistrationChannel();

  let vault: VaultService | undefined;
  let healthServer: Server | undefined;
  const transcriptHealth = new TranscriptHealthTracker({ onEvent: observability.sinks.transcriptHealth });
  if (options.withHealthServer !== false) {
    if (config.vault === undefined) {
      healthServer = startHealthServer(config.httpPort, broker, observability);
      await waitForListening(healthServer);
    } else {
      const vaultConfig = config.vault;
      const transcript = new YouTubeTranscriptService({
        proxy: { username: vaultConfig.webshareProxyUsername, password: vaultConfig.webshareProxyPassword },
        onAttempt: observability.sinks.transcriptAttempt,
      });
      const vaultService = await createVaultService(vaultConfig, {
        transcript,
        onEvent: observability.sinks.vault,
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
      vault = vaultService;
      await vaultService.jobs.start();
      healthServer = createVaultHttpServer({
        keyStore: vaultService.keyStore,
        handlers: {
          ...createVaultRouteHandlers({
            ...vaultService,
            authorizeNotificationAgent: (agentId, keyId) => {
              const agent = services.registry.get(agentId);
              if (agent === undefined) throw new HttpError(404, "Notification agent is not registered");
              if (keyId === undefined || agent.key_id !== keyId) throw new HttpError(403, "Notification agent is bound to a different key");
            },
            health: () => {
              const status = broker.status();
              const transcriptSnapshot = transcriptHealth.snapshot();
              // Broker state is diagnostic only: the deployment gate requires a running HTTP service.
              return {
                status: transcriptSnapshot.degraded ? "degraded" : "ok",
                transcript: {
                  status: transcriptSnapshot.degraded ? "degraded" : "ok",
                  ...transcriptSnapshot,
                  proxy: transcript.getProxyDiagnostic(),
                },
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
            ready: async () => {
              const readiness = await vaultService.ready();
              const status = broker.status();
              const brokerReady = status.connected && status.topologyDeclared;
              return {
                status: readiness.status === "ready" && brokerReady ? "ready" : "degraded",
                checks: {
                  ...readiness.checks,
                  broker: brokerReady ? "ok" : "error:unavailable",
                },
              };
            },
            metrics: () => observability.renderMetrics(),
            metricsContentType: observability.contentType,
            onTranscriptFailure: (videoId, error) => {
              transcriptHealth.recordFailure({ occurredAt: new Date(), failure: safeTranscriptFailure({ videoId, ...error.diagnostic }) });
            },
            onTranscriptSuccess: () => {
              transcriptHealth.recordSuccess({ occurredAt: new Date() });
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
      await waitForListening(healthServer);
    }
  }

  await audit("core_start", { amqp_url: redactAmqpUrl(config.amqpUrl) });

  return {
    config,
    broker,
    healthServer,
    services,
    stop: async () => {
      await closeHttpServer(healthServer);
      deliveries.close();
      await vault?.close();
      await broker.close();
      await audit("core_stop", {});
    },
  };
}
