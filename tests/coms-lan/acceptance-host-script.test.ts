import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadLocalAcceptanceState,
  renderAcceptanceHostReport,
  upsertStaticPeer,
  type AcceptanceHostOptions,
} from "../../scripts/coms-lan-acceptance-host";
import type { ComsLanConfig } from "../../src/coms-lan/config";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Onclave acceptance host script", () => {
  it("renders local key and peer commands without private material", () => {
    const report = renderAcceptanceHostReport(
      {
        root: "/tmp/coms-lan",
        identity: {
          version: 1,
          nodeId: "node_abc",
          publicKey: "cd4d664f23e87b106fc06fd3215508d2d4e254b1b75cf45e44cf30508199b8b1",
          privateKeyPath: "/tmp/coms-lan/identity.key",
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
      createOptions()
    );

    expect(report).toContain("onclave_trust_add");
    expect(report).toContain("wss://127.0.0.1:4444/v1/hub");
    expect(report).not.toContain("identity.key");
    expect(report).not.toContain("privateKey");
  });

  it("initializes a local identity so first run can print a trust line", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-acceptance-host-"));
    tempDirs.push(root);

    const state = await loadLocalAcceptanceState(root);

    expect(state.identity?.nodeId).toMatch(/^node_/);
    expect(state.authorizedKeyLine).toMatch(/^ssh-ed25519 /);
    expect(state.hub).toBeNull();
  });

  it("upserts static peers by name", () => {
    const config: ComsLanConfig = {
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
    root: "/tmp/coms-lan",
    hostName: "host-a",
    writeStaticPeer: false,
    auditScan: false,
    initIdentity: true,
  };
}
