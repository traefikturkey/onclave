import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findStaticPeer, loadOnclaveConfig, parseOnclaveConfig, writeOnclaveConfig } from "../../packages/core/src/onclave/config";
import { getOnclavePaths } from "../../packages/core/src/onclave/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("onclave config", () => {
  it("returns an empty default config when config.json is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-config-"));
    tempDirs.push(root);
    await expect(loadOnclaveConfig(getOnclavePaths(root))).resolves.toEqual({ version: 1, staticPeers: [] });
  });

  it("loads and finds static peers", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-config-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeFile(
      paths.config,
      JSON.stringify({
        version: 1,
        staticPeers: [
          {
            name: "bench",
            nodeId: "node_bench",
            hubInstanceId: "hub_bench",
            endpoint: "wss://192.168.1.20:4444/v1/hub",
          },
        ],
      }),
      "utf8"
    );

    const config = await loadOnclaveConfig(paths);
    expect(findStaticPeer(config, "bench")).toEqual({
      name: "bench",
      nodeId: "node_bench",
      hubInstanceId: "hub_bench",
      endpoint: "wss://192.168.1.20:4444/v1/hub",
    });
  });

  it("writes validated config", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-config-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeOnclaveConfig(paths, {
      version: 1,
      staticPeers: [{ nodeId: "node_a", hubInstanceId: "hub_a", endpoint: "wss://host:1111/v1/hub" }],
    });

    await expect(loadOnclaveConfig(paths)).resolves.toEqual({
      version: 1,
      staticPeers: [{ nodeId: "node_a", hubInstanceId: "hub_a", endpoint: "wss://host:1111/v1/hub" }],
    });
  });

  it("rejects duplicate static peer names and non-WSS endpoints", () => {
    expect(() =>
      parseOnclaveConfig({
        version: 1,
        staticPeers: [
          { name: "dupe", nodeId: "node_a", hubInstanceId: "hub_a", endpoint: "wss://a:1/v1/hub" },
          { name: "dupe", nodeId: "node_b", hubInstanceId: "hub_b", endpoint: "wss://b:1/v1/hub" },
        ],
      })
    ).toThrow(/duplicate static peer name/);

    expect(() =>
      parseOnclaveConfig({
        version: 1,
        staticPeers: [{ nodeId: "node_a", hubInstanceId: "hub_a", endpoint: "http://host:1/v1/hub" }],
      })
    ).toThrow(/wss:\/\//);
  });
});
