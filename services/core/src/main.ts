import { ENVELOPE_VERSION, PROTOCOL_VERSION } from "@onclave/envelope";
import { loadCoreConfig, redactAmqpUrl } from "./config";
import { log } from "./log";
import { startCore, type CoreRuntime } from "./service";

const config = loadCoreConfig();

log("info", "core.starting", {
  amqpUrl: redactAmqpUrl(config.amqpUrl),
  httpPort: config.httpPort,
  envelopeVersion: ENVELOPE_VERSION,
  protocolVersion: PROTOCOL_VERSION,
});

const runtime: CoreRuntime = await startCore({ config });

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  log("info", "core.shutdown", { signal });
  try {
    await runtime.stop();
  } catch (error) {
    log("warn", "core.shutdown_error", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
