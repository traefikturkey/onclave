import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bootstrapLocalHub } from "../src/lib/bootstrap";
import { getOnclavePaths } from "../src/lib/state";

const tempDirs: string[] = [];
const NOW = "2026-05-21T00:00:00.000Z";
const VALID_KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix test@example";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("bootstrapLocalHub", () => {
  it("starts a new local hub runtime when no live hub exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-bootstrap-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeFile(paths.authorizedKeys, `${VALID_KEY_LINE}\n`, "utf8");
    const starts: unknown[] = [];
    const events: unknown[] = [];

    const result = await bootstrapLocalHub(paths, {
      host: "127.0.0.1",
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      now: () => NOW,
      healthCheck: async () => false,
      audit: (event, metadata) => {
        events.push({ event, metadata });
      },
      tlsGenerator: async () => ({ cert: pem("CERTIFICATE", "cert"), key: pem("PRIVATE KEY", "key") }),
      runtimeFactory: async (input) => {
        starts.push(input);
        return {
          state: {
            version: 1,
            nodeId: input.identity.nodeId,
            hubInstanceId: input.hubInstanceId,
            pid: 1234,
            endpoint: "https://127.0.0.1:4444",
            startedAt: NOW,
          },
          stop: async () => undefined,
        };
      },
    });

    expect(result.started).toBe(true);
    expect(result.runtime).toBeDefined();
    expect(result.authorizedKeys).toHaveLength(1);
    expect(result.publicAuthorizedKeyLine).toContain(result.identity.nodeId);
    expect(starts).toHaveLength(1);
    expect(events).toEqual([{ event: "trust_loaded", metadata: { count: 1 } }]);
  });

  it("reuses a live hub state without starting a new runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-bootstrap-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    const first = await bootstrapLocalHub(paths, {
      host: "127.0.0.1",
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      now: () => NOW,
      healthCheck: async () => false,
      tlsGenerator: async () => ({ cert: pem("CERTIFICATE", "cert"), key: pem("PRIVATE KEY", "key") }),
      runtimeFactory: async (input) => ({
        state: {
          version: 1,
          nodeId: input.identity.nodeId,
          hubInstanceId: input.hubInstanceId,
          pid: 1234,
          endpoint: "https://127.0.0.1:4444",
          startedAt: NOW,
        },
        stop: async () => undefined,
      }),
    });

    const second = await bootstrapLocalHub(paths, {
      host: "127.0.0.1",
      discoveryPort: 48889,
      broadcastAddress: "255.255.255.255",
      now: () => NOW,
      healthCheck: async (endpoint) => endpoint === first.state.endpoint,
      tlsGenerator: async () => {
        throw new Error("should not need new TLS material");
      },
      runtimeFactory: async () => {
        throw new Error("should not start runtime");
      },
    });

    expect(second.started).toBe(false);
    expect(second.runtime).toBeNull();
    expect(second.state).toEqual(first.state);
  });
});

function pem(label: string, body: string): string {
  return `-----${"BEGIN"} ${label}-----\n${body}\n-----${"END"} ${label}-----\n`;
}
