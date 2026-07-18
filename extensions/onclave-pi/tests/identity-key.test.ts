import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIdentityPrivateKeyHex } from "../src/lib/identity";
import { getOnclavePaths } from "../src/lib/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadIdentityPrivateKeyHex", () => {
  it("loads the app-specific private signing key from the onclave state root", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-key-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeFile(paths.privateKey, `${"ab".repeat(32)}\n`, "utf8");

    const privateKeyHex = await loadIdentityPrivateKeyHex(paths);

    expect(privateKeyHex).toMatch(/^[a-f0-9]{64}$/);
    expect(paths.privateKey).not.toContain(".ssh");
  });

  it("rejects malformed private key files", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-identity-key-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeFile(paths.privateKey, "not-a-key\n", "utf8");

    await expect(loadIdentityPrivateKeyHex(paths)).rejects.toThrow(/private key must be 32 bytes/);
  });
});
