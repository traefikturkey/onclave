import { join } from "node:path";
import type { BudgetLimits } from "@onclave/envelope";
import { loadVaultConfig, type VaultConfig } from "./vault/config";

export type CoreConfig = {
  amqpUrl: string;
  httpPort: number;
  dataDir: string;
  registryPath: string;
  a2aStatePath?: string;
  auditPath: string;
  trustDir: string;
  queueTtlMs: number;
  queueMaxLength: number;
  heartbeatStaleMs: number;
  budgetLimits: BudgetLimits;
  connectRetryBaseMs: number;
  connectRetryMaxMs: number;
  vault?: VaultConfig;
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
  const vaultEnabled = Boolean(env.ONCLAVE_VAULT_POSTGRES_PASSWORD?.trim());
  const amqpUrl = env.ONCLAVE_AMQP_URL?.trim();
  if (!amqpUrl) throw new Error("ONCLAVE_AMQP_URL is required");
  return {
    amqpUrl,
    httpPort: parsePort(env.ONCLAVE_HTTP_PORT, 8080),
    dataDir,
    registryPath: join(dataDir, "registry.json"),
    a2aStatePath: join(dataDir, "a2a-state-v1.json"),
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
    ...(vaultEnabled ? { vault: loadVaultConfig(env) } : {}),
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
