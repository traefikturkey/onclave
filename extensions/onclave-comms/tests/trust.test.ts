import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addAuthorizedKeyLine, formatAuthorizedKeyLine, loadAuthorizedKeys } from "../src/lib/trust";
import { getOnclavePaths } from "../src/lib/state";
import type { OnclaveIdentity } from "../src/lib/identity";

const tempDirs: string[] = [];
const VALID_KEY_LINE =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix test@example";

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadAuthorizedKeys", () => {
  it("returns an empty trust set when authorized_keys is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-trust-"));
    tempDirs.push(root);

    expect(await loadAuthorizedKeys(getOnclavePaths(root))).toEqual([]);
  });

  it("loads ssh-ed25519 keys from authorized_keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-trust-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    await writeFile(paths.authorizedKeys, `${VALID_KEY_LINE}\n`, "utf8");

    const keys = await loadAuthorizedKeys(paths);

    expect(keys).toHaveLength(1);
    expect(keys[0]?.comment).toBe("test@example");
  });
});

describe("addAuthorizedKeyLine", () => {
  it("validates, appends, and dedupes public key lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-trust-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);

    await expect(addAuthorizedKeyLine(paths, VALID_KEY_LINE)).resolves.toMatchObject({ added: true });
    await expect(addAuthorizedKeyLine(paths, VALID_KEY_LINE)).resolves.toMatchObject({ added: false });

    expect((await readFile(paths.authorizedKeys, "utf8")).trim().split(/\r?\n/)).toEqual([VALID_KEY_LINE]);
  });

  it("rejects unsupported key lines", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-trust-"));
    tempDirs.push(root);
    await expect(addAuthorizedKeyLine(getOnclavePaths(root), "ssh-rsa AAAA nope")).rejects.toThrow(/unsupported/);
  });
});

describe("formatAuthorizedKeyLine", () => {
  it("formats a persistent identity public key for authorized_keys import", () => {
    const identity: OnclaveIdentity = {
      version: 1,
      nodeId: "node_01KS6QDHA43K8FH6AATBTMATHD",
      publicKey: "cd4d664f23e87b106fc06fd3215508d2d4e254b1b75cf45e44cf30508199b8b1", // pragma: allowlist secret
      privateKeyPath: "/tmp/onclave/identity.key",
      createdAt: "2026-05-21T00:00:00.000Z",
    };

    expect(formatAuthorizedKeyLine(identity)).toBe(
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIM1NZk8j6HsQb8Bv0yFVCNLU4lSxt1z0XkTPMFCBmbix node_01KS6QDHA43K8FH6AATBTMATHD"
    );
  });
});
