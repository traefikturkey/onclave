import { readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bwsExecutablePath, loadApiBaseFromBws } from "../src/lib/bws";

const PROJECT_ID = "3b241101-e2bb-4255-8caf-4136c566a962";
const baseEnvironment = {
  BITWARDEN_ACCESS_KEY: "bootstrap-token",
  BITWARDEN_API_SERVER: "https://vault.example.internal/api/",
  ONCLAVE_BWS_PROJECT_ID: PROJECT_ID,
};

const apiBaseSecret = JSON.stringify([
  { key: "ONCLAVE_API_BASE", value: "https://api.example.internal/api/v1" },
]);

describe("Bitwarden API configuration", () => {
  it("does not invoke BWS without the bootstrap access key", async () => {
    const runner = vi.fn();

    await expect(loadApiBaseFromBws({}, runner)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses the installer-owned absolute BWS executable path on supported platforms", () => {
    const linuxPath = bwsExecutablePath("linux", "/home/onclave");
    const windowsPath = bwsExecutablePath("win32", "C:\\Users\\onclave");

    expect(linuxPath).toBe("/home/onclave/.local/bin/bws");
    expect(posix.isAbsolute(linuxPath)).toBe(true);
    expect(windowsPath).toBe("C:\\Users\\onclave\\.local\\bin\\bws.exe");
    expect(win32.isAbsolute(windowsPath)).toBe(true);
  });

  it("loads only the API base from the configured BWS project and server", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: apiBaseSecret });
    const environment = {
      ...baseEnvironment,
      BWS_SERVER_URL: "https://inherited.example.internal",
      BWS_CONFIG_FILE: "/tmp/untrusted-bws-config.json",
      BWS_PROFILE: "untrusted-profile",
      bws_config_file: "C:\\untrusted-bws-config.json",
      Bws_Profile: "mixed-case-profile",
      bWs_SeRvEr_Url: "https://mixed-case.example.internal",
    };

    await expect(loadApiBaseFromBws(environment, runner)).resolves.toBe(
      "https://api.example.internal/api/v1"
    );
    expect(runner).toHaveBeenCalledWith(
      bwsExecutablePath(),
      ["secret", "list", "--output", "json", "--", PROJECT_ID],
      expect.objectContaining({
        env: expect.objectContaining({
          BWS_ACCESS_TOKEN: "bootstrap-token",
          BWS_SERVER_URL: "https://vault.example.internal",
        }),
      })
    );
    expect(runner).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        env: expect.not.objectContaining({
          BWS_CONFIG_FILE: expect.anything(),
          BWS_PROFILE: expect.anything(),
          bws_config_file: expect.anything(),
          Bws_Profile: expect.anything(),
          bWs_SeRvEr_Url: expect.anything(),
        }),
      })
    );
    expect(environment).not.toHaveProperty("BWS_ACCESS_TOKEN");
    expect(environment).not.toHaveProperty("ONCLAVE_API_BASE");
  });

  it("fails closed instead of using inherited BWS configuration without a pinned server", async () => {
    const runner = vi.fn();

    await expect(
      loadApiBaseFromBws(
        {
          BITWARDEN_ACCESS_KEY: "bootstrap-token",
          ONCLAVE_BWS_PROJECT_ID: PROJECT_ID,
          BWS_SERVER_URL: "https://inherited.example.internal",
          BWS_CONFIG_FILE: "/tmp/untrusted-bws-config.json",
          BWS_PROFILE: "untrusted-profile",
        },
        runner
      )
    ).rejects.toThrow("Onclave BWS bootstrap is missing BITWARDEN_API_SERVER");
    expect(runner).not.toHaveBeenCalled();
  });

  it("requires an explicitly configured BWS project UUID", async () => {
    const runner = vi.fn();

    await expect(loadApiBaseFromBws({ BITWARDEN_ACCESS_KEY: "bootstrap-token" }, runner)).rejects.toThrow(
      "Onclave BWS bootstrap is missing ONCLAVE_BWS_PROJECT_ID"
    );
    expect(runner).not.toHaveBeenCalled();
  });

  it.each(["project-id", "--server-url=https://attacker.example", "3b241101-e2bb-4255-8caf-4136c566a96"]) (
    "rejects an invalid BWS project ID before invoking BWS",
    async (invalidProjectId) => {
      const runner = vi.fn();

      const error = await loadApiBaseFromBws(
        { BITWARDEN_ACCESS_KEY: "bootstrap-token", ONCLAVE_BWS_PROJECT_ID: invalidProjectId },
        runner
      ).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      if (error instanceof Error) {
        expect(error.message).toBe("Onclave BWS bootstrap requires a valid ONCLAVE_BWS_PROJECT_ID");
        expect(error.message).not.toContain(invalidProjectId);
      }
      expect(runner).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["an HTTP URL", "http://vault.example.internal/api"],
    ["a credentialed URL", "https://operator:secret@vault.example.internal/api"],
    ["a URL with a query", "https://vault.example.internal/api?region=private"],
    ["a URL with an empty query", "https://vault.example.internal/api?"],
    ["a URL with a fragment", "https://vault.example.internal/api#private"],
  ])("rejects %s before invoking BWS", async (_description, apiServer) => {
    const runner = vi.fn();

    const error = await loadApiBaseFromBws(
      { ...baseEnvironment, BITWARDEN_API_SERVER: apiServer },
      runner
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toContain("BITWARDEN_API_SERVER");
      expect(error.message).not.toContain(apiServer);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("normalizes an API path suffix before invoking BWS", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: apiBaseSecret });

    await expect(
      loadApiBaseFromBws({ ...baseEnvironment, BITWARDEN_API_SERVER: "https://vault.example.internal/api///" }, runner)
    ).resolves.toBe("https://api.example.internal/api/v1");
    expect(runner).toHaveBeenCalledWith(
      bwsExecutablePath(),
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ BWS_SERVER_URL: "https://vault.example.internal" }),
      })
    );
  });

  it("rejects a BWS response without the API base key", async () => {
    const runner = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ key: "UNRELATED_SETTING", value: "unrelated-value" }]),
    });

    await expect(loadApiBaseFromBws(baseEnvironment, runner)).rejects.toThrow(
      "Onclave BWS secret ONCLAVE_API_BASE is missing"
    );
  });

  it("rejects malformed BWS output without exposing its contents", async () => {
    const runner = vi.fn().mockResolvedValue({ stdout: "not-json-secret-output" });

    await expect(loadApiBaseFromBws(baseEnvironment, runner)).rejects.toThrow(
      "Onclave BWS returned invalid JSON"
    );
  });

  it("redacts BWS command failures", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("sensitive subprocess output"));

    const error = await loadApiBaseFromBws(baseEnvironment, runner).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    if (error instanceof Error) {
      expect(error.message).toBe("Onclave could not read its Bitwarden Secrets Manager project");
      expect(error.message).not.toContain("sensitive subprocess output");
    }
  });

  it("contains no broker configuration or client dependency references", async () => {
    const [entrypoint, bwsSource, packageManifest] = await Promise.all([
      readFile(new URL("../src/onclave-pi.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/lib/bws.ts", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
    ]);
    const prohibited = ["amqp", ["RABBIT", "MQ"].join("")].join("|");

    expect(`${entrypoint}\n${bwsSource}`).not.toMatch(new RegExp(prohibited, "i"));
    expect(packageManifest).not.toMatch(new RegExp(prohibited, "i"));
  });
});
