import { join } from "node:path";
import type { BudgetLimits } from "@onclave/envelope";

export type CoreConfig = {
  amqpUrl: string;
  httpPort: number;
  dataDir: string;
  registryPath: string;
  conversationsPath: string;
  auditPath: string;
  trustDir: string;
  queueTtlMs: number;
  queueMaxLength: number;
  heartbeatStaleMs: number;
  budgetLimits: BudgetLimits;
  connectRetryBaseMs: number;
  connectRetryMaxMs: number;
};

function parseIntEnv(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = parseIntEnv(value, fallback, "port");
  if (parsed > 65535) throw new Error(`invalid port value: ${parsed}`);
  return parsed;
}

export function loadCoreConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const dataDir = env.ONCLAVE_DATA_DIR ?? "/data";
  return {
    amqpUrl: env.ONCLAVE_AMQP_URL ?? "amqp://onclave:onclave-dev@localhost:5672/onclave",
    httpPort: parsePort(env.ONCLAVE_HTTP_PORT, 8080),
    dataDir,
    registryPath: join(dataDir, "registry.json"),
    conversationsPath: join(dataDir, "conversations.json"),
    auditPath: join(dataDir, "audit.jsonl"),
    trustDir: join(dataDir, "trust"),
    queueTtlMs: parseIntEnv(env.ONCLAVE_QUEUE_TTL_MS, 86400000, "queue ttl"),
    queueMaxLength: parseIntEnv(env.ONCLAVE_QUEUE_MAX_LENGTH, 1000, "queue max length"),
    heartbeatStaleMs: parseIntEnv(env.ONCLAVE_HEARTBEAT_STALE_MS, 90000, "heartbeat stale ms"),
    budgetLimits: {
      maxExchanges: parseIntEnv(env.ONCLAVE_MAX_EXCHANGES, 16, "max exchanges"),
      maxTotalTokens: parseIntEnv(env.ONCLAVE_MAX_TOTAL_TOKENS, 200000, "max total tokens"),
    },
    connectRetryBaseMs: 500,
    connectRetryMaxMs: 15000,
  };
}

export function redactAmqpUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") {
      parsed.username = "***";
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "<unparseable amqp url>";
  }
}
