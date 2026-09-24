import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deliveryRetryDelay } from "../src/vault/durability";
import { migrateVaultDurability } from "../src/vault/db";
import { loadVaultConfig } from "../src/vault/config";

type QueryCall = { text: string; values: unknown[] | undefined };

function configuredEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ONCLAVE_VAULT_POSTGRES_PASSWORD: "postgres-secret",
    ONCLAVE_VAULT_S3_ACCESS_KEY: "access",
    ONCLAVE_VAULT_S3_SECRET_KEY: "secret",
    ONCLAVE_VAULT_WEBSHARE_PROXY_USERNAME: "proxy-user",
    ONCLAVE_VAULT_WEBSHARE_PROXY_PASSWORD: "proxy-password",
    ...overrides,
  };
}

describe("vault job durability migration", () => {
  it("executes the additive migration transactionally and safely repeats it", async () => {
    const calls: QueryCall[] = [];
    const client = {
      async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
        calls.push({ text, values });
        return { rows: [], rowCount: 0 };
      },
      release(): void {},
    };
    const pool = { connect: async () => client };

    await migrateVaultDurability(pool as never);
    await migrateVaultDurability(pool as never);

    expect(calls.filter(({ text }) => text === "BEGIN")).toHaveLength(2);
    expect(calls.filter(({ text }) => text === "COMMIT")).toHaveLength(2);
    const migrations = calls.filter(({ text }) => text.includes("ALTER TABLE pipeline_job"));
    expect(migrations).toHaveLength(2);
    expect(migrations[0]?.text).toContain("ADD COLUMN IF NOT EXISTS request_payload jsonb");
    expect(migrations[0]?.text).toContain("ADD COLUMN IF NOT EXISTS claim_token text");
    expect(migrations[0]?.text).toContain("CREATE TABLE IF NOT EXISTS pipeline_job_delivery");
    expect(migrations[0]?.text).toContain("ON CONFLICT (name) DO NOTHING");
  });

  it("rolls back a failed migration and releases the transaction client", async () => {
    const calls: QueryCall[] = [];
    let released = false;
    const client = {
      async query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
        calls.push({ text, values });
        if (text.includes("ALTER TABLE pipeline_job")) throw new Error("migration failed");
        return { rows: [], rowCount: 0 };
      },
      release(): void { released = true; },
    };
    const pool = { connect: async () => client };

    await expect(migrateVaultDurability(pool as never)).rejects.toThrow("migration failed");
    expect(calls.map(({ text }) => text === "BEGIN" || text === "ROLLBACK" ? text : "migration")).toEqual(["BEGIN", "migration", "ROLLBACK"]);
    expect(released).toBe(true);
  });

  it("keeps the bootstrap schema and upgrade migration aligned", async () => {
    const [schema, migration] = await Promise.all([
      readFile(new URL("../../../deploy/app/onclave/vault-schema.sql", import.meta.url), "utf8"),
      readFile(new URL("../src/vault/migrations/20260722_job_durability.sql", import.meta.url), "utf8"),
    ]);
    for (const column of ["request_payload jsonb", "claim_token text", "lease_expires_at timestamptz"]) {
      expect(schema).toContain(column);
      expect(migration).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS pipeline_job_delivery");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS pipeline_job_delivery");
  });
});

describe("vault durable delivery policy", () => {
  it("uses bounded exponential retries", () => {
    expect([1, 2, 3, 12].map((attempt) => deliveryRetryDelay(attempt, 1_000, 5_000))).toEqual([1_000, 2_000, 4_000, 5_000]);
  });

  it("exposes validated retry and recovery defaults with optional overrides", () => {
    const defaults = loadVaultConfig(configuredEnv());
    expect(defaults).toMatchObject({
      jobRecoveryBatchSize: 50,
      jobLeaseMs: 300_000,
      deliveryPollIntervalMs: 1_000,
      deliveryLeaseMs: 300_000,
      deliveryRetryBaseMs: 1_000,
      deliveryRetryMaxMs: 900_000,
      deliveryBatchSize: 50,
    });
    const configured = loadVaultConfig(configuredEnv({
      ONCLAVE_VAULT_JOB_RECOVERY_BATCH_SIZE: "8",
      ONCLAVE_VAULT_JOB_LEASE_MS: "60000",
      ONCLAVE_VAULT_DELIVERY_POLL_INTERVAL_MS: "500",
      ONCLAVE_VAULT_DELIVERY_LEASE_MS: "120000",
      ONCLAVE_VAULT_DELIVERY_RETRY_BASE_MS: "250",
      ONCLAVE_VAULT_DELIVERY_RETRY_MAX_MS: "30000",
      ONCLAVE_VAULT_DELIVERY_BATCH_SIZE: "12",
    }));
    expect(configured).toMatchObject({ jobRecoveryBatchSize: 8, jobLeaseMs: 60_000, deliveryPollIntervalMs: 500, deliveryLeaseMs: 120_000, deliveryRetryBaseMs: 250, deliveryRetryMaxMs: 30_000, deliveryBatchSize: 12 });
    expect(() => loadVaultConfig(configuredEnv({ ONCLAVE_VAULT_DELIVERY_RETRY_BASE_MS: "5000", ONCLAVE_VAULT_DELIVERY_RETRY_MAX_MS: "1000" }))).toThrow("DELIVERY_RETRY_MAX_MS must not be less than DELIVERY_RETRY_BASE_MS");
    expect(() => loadVaultConfig(configuredEnv({ ONCLAVE_VAULT_DELIVERY_BATCH_SIZE: "1.5" }))).toThrow("invalid DELIVERY_BATCH_SIZE: 1.5");
    expect(() => loadVaultConfig(configuredEnv({ ONCLAVE_VAULT_DELIVERY_LEASE_MS: "10000" }))).toThrow("invalid DELIVERY_LEASE_MS: 10000");
  });
});
