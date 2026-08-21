import { describe, expect, it } from "vitest";
import { loadCoreConfig } from "../src/config";

describe("core configuration", () => {
  it("requires an explicit broker URL", () => {
    expect(() => loadCoreConfig({})).toThrow("ONCLAVE_AMQP_URL is required");
  });

  it("uses the configured broker URL", () => {
    const config = loadCoreConfig({
      ONCLAVE_AMQP_URL: "amqp://rabbitmq.example.internal:5672/onclave",
      ONCLAVE_DATA_DIR: "/tmp/onclave",
    });

    expect(config.amqpUrl).toBe("amqp://rabbitmq.example.internal:5672/onclave");
    expect(config.agentRetentionMs).toBe(86_400_000);
  });

  it("activates the vault only with its canonical password variable", () => {
    const env = {
      ONCLAVE_AMQP_URL: "amqp://rabbitmq.example.internal:5672/onclave",
      ONCLAVE_VAULT_POSTGRES_PASSWORD: "postgres-secret",
      ONCLAVE_VAULT_S3_ACCESS_KEY: "access",
      ONCLAVE_VAULT_S3_SECRET_KEY: "secret",
      ONCLAVE_VAULT_WEBSHARE_PROXY_USERNAME: "proxy-user",
      ONCLAVE_VAULT_WEBSHARE_PROXY_PASSWORD: "proxy-password",
    };

    expect(loadCoreConfig(env).vault).toBeDefined();
    expect(loadCoreConfig({ ...env, ONCLAVE_VAULT_POSTGRES_PASSWORD: undefined, MENOS_POSTGRES_PASSWORD: "menos-secret", POSTGRES_PASSWORD: "legacy-secret" }).vault).toBeUndefined();
  });
});
