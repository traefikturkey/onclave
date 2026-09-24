import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import type { VaultConfig } from "./config";

export function createVaultPool(config: VaultConfig): Pool {
  return new Pool({
    host: config.postgresHost,
    port: config.postgresPort,
    database: config.postgresDatabase,
    user: config.postgresUser,
    password: config.postgresPassword,
    min: config.postgresPoolMinSize,
    max: config.postgresPoolMaxSize,
    connectionTimeoutMillis: 10_000,
  });
}

export async function checkVaultDatabase(pool: Pool): Promise<void> {
  await pool.query("SELECT 1");
}

export async function migrateVaultDurability(pool: Pool): Promise<void> {
  const migration = await readFile(new URL("./migrations/20260722_job_durability.sql", import.meta.url), "utf8");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration);
    await client.query("COMMIT");
  } catch (error: unknown) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
