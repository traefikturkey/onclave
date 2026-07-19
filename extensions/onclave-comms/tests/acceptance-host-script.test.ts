import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLocalAcceptanceState,
  renderAcceptanceHostReport,
  upsertStaticPeer,
  type AcceptanceHostOptions,
} from "../scripts/onclave-acceptance-host";
import type { OnclaveConfig } from "../src/lib/config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Onclave acceptance host script", () => {
  it("renders local key and peer commands without private material", () => {
    const report = renderAcceptanceHostReport(
      {
        root: "/tmp/onclave",
        identity: {
          version: 1,
          nodeId: "node_abc",
          publicKey: "cd4d664f23e87b106fc06fd3215508d2d4e254b1b75cf45e44cf30508199b8b1", // pragma: allowlist secret
          privateKeyPath: "/tmp/onclave/identity.key",
          createdAt: "2026-05-21T00:00:00.000Z",
        },
        hub: {
          version: 1,
          nodeId: "node_abc",
          hubInstanceId: "hub_abc",
          pid: 123,
          endpoint: "https://127.0.0.1:4444",
          startedAt: "2026-05-21T00:00:00.000Z",
        },
        authorizedKeyLine:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix node_abc",
        config: { version: 1, staticPeers: [] },
        auditLogExists: false,
      },
      {
        ...createOptions(),
        peer: {
          name: "host-b",
          nodeId: "node_b",
          hubInstanceId: "hub_b",
          endpoint: "wss://203.0.113.51:4444/v1/hub",
        },
      }
    );

    expect(report).toContain("onclave_trust_add");
    expect(report).toContain("wss://127.0.0.1:4444/v1/hub");
    expect(report).toContain("do not poll onclave_remote_get");
    expect(report).not.toContain("identity.key");
    expect(report).not.toContain("privateKey");
  });

  it("initializes a local identity so first run can print a trust line", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-acceptance-host-"));
    tempDirs.push(root);

    const state = await loadLocalAcceptanceState(root);

    expect(state.identity?.nodeId).toMatch(/^node_/);
    expect(state.authorizedKeyLine).toMatch(/^ssh-ed25519 /);
    expect(state.hub).toBeNull();
  });

  it("upserts static peers by name", () => {
    const config: OnclaveConfig = {
      version: 1,
      staticPeers: [
        { name: "host-b", nodeId: "old", hubInstanceId: "old-hub", endpoint: "wss://old:1/v1/hub" },
        { name: "host-c", nodeId: "node-c", hubInstanceId: "hub-c", endpoint: "wss://host-c:2/v1/hub" },
      ],
    };

    expect(
      upsertStaticPeer(config, {
        name: "host-b",
        nodeId: "node-b",
        hubInstanceId: "hub-b",
        endpoint: "wss://host-b:3/v1/hub",
      })
    ).toEqual({
      version: 1,
      staticPeers: [
        { name: "host-c", nodeId: "node-c", hubInstanceId: "hub-c", endpoint: "wss://host-c:2/v1/hub" },
        { name: "host-b", nodeId: "node-b", hubInstanceId: "hub-b", endpoint: "wss://host-b:3/v1/hub" },
      ],
    });
  });
});

function createOptions(): AcceptanceHostOptions {
  return {
    root: "/tmp/onclave",
    hostName: "host-a",
    writeStaticPeer: false,
    auditScan: false,
    initIdentity: true,
  };
}
