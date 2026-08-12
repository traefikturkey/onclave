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
  });
});
