import { describe, expect, it, vi } from "vitest";
import { loadBrokerUrlFromBws } from "../src/lib/bws";

const baseEnvironment = {
  BITWARDEN_ACCESS_KEY: "bootstrap-token",
  BITWARDEN_API_SERVER: "https://vault.example.internal/api/",
  ONCLAVE_BWS_PROJECT_ID: "project-id",
  ONCLAVE_AMQP_ENDPOINT: "amqps://broker.example.internal:5671/onclave",
};

describe("Bitwarden broker configuration", () => {
  it("does not invoke BWS without the bootstrap token", async () => {
    const runner = vi.fn();

    await expect(loadBrokerUrlFromBws({}, runner)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses the default project with an explicit endpoint", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { key: "RABBITMQ_DEFAULT_USER", value: "onclave-agent" },
        { key: "RABBITMQ_DEFAULT_PASS", value: "password" },
      ]),
    });

    const result = await loadBrokerUrlFromBws(
      {
        BITWARDEN_ACCESS_KEY: "bootstrap-token",
        ONCLAVE_AMQP_ENDPOINT: "amqp://rabbitmq.example.internal:5672/onclave",
      },
      runner
    );

    expect(result).toBe("amqp://onclave-agent:password@rabbitmq.example.internal:5672/onclave");
    expect(runner).toHaveBeenCalledWith(
      "bws",
      ["secret", "list", "06e2f73a-9869-40dc-b430-b48500175560", "--output", "json"],
      expect.anything()
    );
  });

  it("combines the non-secret endpoint with BWS credentials", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { key: "RABBITMQ_DEFAULT_USER", value: "onclave-agent" },
        { key: "RABBITMQ_DEFAULT_PASS", value: "password with punctuation !" },
      ]),
    });

    const result = await loadBrokerUrlFromBws(baseEnvironment, runner);

    expect(result).toBe(
      "amqps://onclave-agent:password%20with%20punctuation%20!@broker.example.internal:5671/onclave"
    );
    expect(runner).toHaveBeenCalledWith(
      "bws",
      ["secret", "list", "project-id", "--output", "json"],
      expect.objectContaining({
        env: expect.objectContaining({
          BWS_ACCESS_TOKEN: "bootstrap-token",
          BWS_SERVER_URL: "https://vault.example.internal",
        }),
      })
    );
  });

  it("rejects credential-bearing endpoint configuration", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { key: "RABBITMQ_DEFAULT_USER", value: "onclave" },
        { key: "RABBITMQ_DEFAULT_PASS", value: "long-password-value" },
      ]),
    });

    await expect(
      loadBrokerUrlFromBws(
        { ...baseEnvironment, ONCLAVE_AMQP_ENDPOINT: "amqp://user:pass@broker/onclave" },
        runner
      )
    ).rejects.toThrow("must not contain credentials");
  });

  it("redacts BWS command failures", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("sensitive subprocess output"));

    await expect(loadBrokerUrlFromBws(baseEnvironment, runner)).rejects.toThrow(
      "Onclave could not read its Bitwarden Secrets Manager project"
    );
  });
});
