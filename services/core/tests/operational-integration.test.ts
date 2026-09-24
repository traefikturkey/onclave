import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreConfig } from "../src/config";
import { startCore, type CoreRuntime } from "../src/service";

function coreConfig(dataDir: string): CoreConfig {
  return {
    amqpUrl: "amqp://127.0.0.1:1",
    httpPort: 0,
    dataDir,
    registryPath: join(dataDir, "registry.json"),
    a2aStatePath: join(dataDir, "a2a-state-v1.json"),
    channelStatePath: join(dataDir, "channels-state-v2.json"),
    auditPath: join(dataDir, "audit.jsonl"),
    trustDir: join(dataDir, "trust"),
    queueTtlMs: 86_400_000,
    queueMaxLength: 1_000,
    heartbeatStaleMs: 90_000,
    budgetLimits: { maxExchanges: 16, maxTotalTokens: 200_000 },
    connectRetryBaseMs: 60_000,
    connectRetryMaxMs: 60_000,
  };
}

describe("core operational HTTP integration", () => {
  const directories: string[] = [];
  const runtimes: CoreRuntime[] = [];

  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.stop();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("keeps liveness and idle metrics available while broker health and readiness are degraded", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "onclave-operational-"));
    directories.push(dataDir);
    const runtime = await startCore({ config: coreConfig(dataDir) });
    runtimes.push(runtime);
    const address = runtime.healthServer?.address();
    if (address === undefined || address === null || typeof address === "string") throw new Error("HTTP server did not bind");
    const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

    const live = await fetch(`${baseUrl}/live`);
    expect(live.status).toBe(200);
    await expect(live.json()).resolves.toEqual({ status: "ok" });

    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(503);
    await expect(health.json()).resolves.toMatchObject({
      status: "degraded",
      broker: { connected: false, topologyDeclared: false },
    });

    const ready = await fetch(`${baseUrl}/ready`);
    expect(ready.status).toBe(503);
    await expect(ready.json()).resolves.toEqual({
      status: "degraded",
      checks: { broker: "error:unavailable" },
    });

    const metrics = await fetch(`${baseUrl}/metrics`);
    expect(metrics.status).toBe(200);
    expect(metrics.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const body = await metrics.text();
    expect(body).toContain("# HELP onclave_transcript_attempts_total");
    expect(body).toContain("# TYPE onclave_transcript_attempts_total counter");
    expect(body).toContain("# HELP onclave_vault_provider_requests_total");
    expect(body).toContain("# TYPE onclave_vault_provider_requests_total counter");

    await runtime.stop();
    runtimes.pop();
    expect(runtime.healthServer?.listening).toBe(false);
  });

  it("stops cleanly when no HTTP server was started", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "onclave-operational-headless-"));
    directories.push(dataDir);
    const runtime = await startCore({ config: coreConfig(dataDir), withHealthServer: false });

    await expect(runtime.stop()).resolves.toBeUndefined();
    expect(runtime.healthServer).toBeUndefined();
  });
});
