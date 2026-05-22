import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIdentityPrivateKeyHex, loadOrCreateIdentity } from "../../src/onclave/identity";
import { getOnclavePaths } from "../../src/onclave/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadIdentityPrivateKeyHex", () => {
  it("loads the app-specific private signing key from the onclave state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-key-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await loadOrCreateIdentity(paths);

    const privateKeyHex = await loadIdentityPrivateKeyHex(paths);

    expect(privateKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(paths.privateKey).not.toContain(".ssh");
  });

  it("rejects malformed private key files", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-key-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await Bun.write(paths.privateKey, "not-a-key\n");

    await expect(loadIdentityPrivateKeyHex(paths)).rejects.toThrow(/private key must be 32 bytes/);
  });
});
