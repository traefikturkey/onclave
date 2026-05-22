import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadOrCreateIdentity } from "../../src/onclave/identity";
import { getOnclavePaths } from "../../src/onclave/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadOrCreateIdentity", () => {
  it("creates a persistent node identity and app-specific signing key", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);

    const identity = await loadOrCreateIdentity(paths);

    expect(identity.version).toBe(1);
    expect(identity.nodeId).toMatch(/^node_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(identity.publicKey).toMatch(/^[a-f0-9]{64}$/);
    expect(identity.privateKeyPath).toBe(paths.privateKey);

    const privateKey = await readFile(paths.privateKey, "utf8");
    const identityJson = await readFile(paths.identity, "utf8");
    expect(identityJson).not.toContain(privateKey.trim());
    expect(identityJson).not.toContain("secret");
    expect(identity.privateKeyPath).not.toContain(".ssh");
    expect(privateKey.trim()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads the same identity on subsequent calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);

    const first = await loadOrCreateIdentity(paths);
    const second = await loadOrCreateIdentity(paths);

    expect(second).toEqual(first);
  });
});
