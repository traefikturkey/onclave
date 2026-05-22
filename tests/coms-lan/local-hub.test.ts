import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readHubState,
  startOrDiscoverLocalHub,
  writeHubState,
  type HubState,
} from "../../src/coms-lan/local-hub";
import { getComsLanPaths } from "../../src/coms-lan/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("local hub state", () => {
  it("writes and reads valid hub state", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-hub-"));
    tempDirs.push(root);
    const paths = getComsLanPaths(root);
    const state = createHubState({ endpoint: "https://127.0.0.1:4444" });

    await writeHubState(paths, state);

    expect(await readHubState(paths)).toEqual(state);
  });

  it("returns null for missing or invalid hub state", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-hub-"));
    tempDirs.push(root);
    const paths = getComsLanPaths(root);

    expect(await readHubState(paths)).toBeNull();

    await writeHubState(paths, { ...createHubState(), version: 999 } as unknown as HubState);

    expect(await readHubState(paths)).toBeNull();
  });
});

describe("startOrDiscoverLocalHub", () => {
  it("reuses an existing live hub", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-hub-"));
    tempDirs.push(root);
    const paths = getComsLanPaths(root);
    const liveState = createHubState({ endpoint: "https://127.0.0.1:4444" });
    await writeHubState(paths, liveState);
    let starts = 0;

    const result = await startOrDiscoverLocalHub(paths, {
      healthCheck: async (endpoint) => endpoint === liveState.endpoint,
      startHub: async () => {
        starts += 1;
        return createHubState({ endpoint: "https://127.0.0.1:5555" });
      },
    });

    expect(result.state).toEqual(liveState);
    expect(result.started).toBe(false);
    expect(starts).toBe(0);
  });

  it("replaces stale hub state by starting a new hub", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-hub-"));
    tempDirs.push(root);
    const paths = getComsLanPaths(root);
    await writeHubState(paths, createHubState({ endpoint: "https://127.0.0.1:4444" }));
    const replacement = createHubState({ endpoint: "https://127.0.0.1:5555" });

    const result = await startOrDiscoverLocalHub(paths, {
      healthCheck: async () => false,
      startHub: async () => replacement,
    });

    expect(result).toEqual({ state: replacement, started: true });
    expect(await readHubState(paths)).toEqual(replacement);
  });

  it("uses the lock to prevent duplicate hub startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-hub-"));
    tempDirs.push(root);
    const paths = getComsLanPaths(root);
    const created = createHubState({ endpoint: "https://127.0.0.1:6666" });
    let starts = 0;

    const options = {
      healthCheck: async (endpoint: string) => endpoint === created.endpoint,
      startHub: async () => {
        starts += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return created;
      },
      lockRetryMs: 5,
      lockTimeoutMs: 1_000,
    };

    const [first, second] = await Promise.all([
      startOrDiscoverLocalHub(paths, options),
      startOrDiscoverLocalHub(paths, options),
    ]);

    expect(starts).toBe(1);
    expect([first.started, second.started].sort()).toEqual([false, true]);
    expect(first.state).toEqual(created);
    expect(second.state).toEqual(created);
  });
});

function createHubState(overrides: Partial<HubState> = {}): HubState {
  return {
    version: 1,
    nodeId: "node_01KS6QDHA43K8FH6AATBTMATHD",
    hubInstanceId: "hub_01KS6QDHA43K8FH6AATBTMATHE",
    pid: 1234,
    endpoint: "https://127.0.0.1:4444",
    startedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}
