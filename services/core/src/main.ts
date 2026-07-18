import { ENVELOPE_VERSION } from "@onclave/envelope";
import { loadCoreConfig, redactAmqpUrl } from "./config";
import { startBroker } from "./broker";
import { startHealthServer } from "./health";
import { log } from "./log";

const config = loadCoreConfig();

log("info", "core.starting", {
  amqpUrl: redactAmqpUrl(config.amqpUrl),
  httpPort: config.httpPort,
  envelopeVersion: ENVELOPE_VERSION,
});

const broker = startBroker({
  amqpUrl: config.amqpUrl,
  retryBaseMs: config.connectRetryBaseMs,
  retryMaxMs: config.connectRetryMaxMs,
});

const healthServer = startHealthServer(config.httpPort, broker);

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("info", "core.shutdown", { signal });
  healthServer.close();
  try {
    await broker.close();
  } catch (error) {
    log("warn", "core.shutdown_broker_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
