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
