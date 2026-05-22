import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteJson, ensureComsLanRoot, getComsLanPaths } from "../../src/coms-lan/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("coms-lan state helpers", () => {
  it("derives all state paths under the configured root", () => {
    const root = join("tmp", "pi-root");
    const paths = getComsLanPaths(root);

    expect(paths.root).toBe(root);
    expect(paths.authorizedKeys).toBe(join(root, "authorized_keys"));
    expect(paths.auditLog).toBe(join(root, "audit.log.jsonl"));
    expect(paths.hubState).toBe(join(root, "hub.json"));
    expect(paths.identity).toBe(join(root, "identity.json"));
    expect(paths.privateKey).toBe(join(root, "identity.key"));
    expect(paths.runtimeDir).toBe(join(root, "runtime"));
  });

  it("creates root and runtime directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-state-"));
    tempDirs.push(root);
    const target = join(root, "nested");

    await ensureComsLanRoot(target);

    expect((await stat(target)).isDirectory()).toBe(true);
    expect((await stat(join(target, "runtime"))).isDirectory()).toBe(true);
  });

  it("writes JSON atomically with a trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "coms-lan-state-"));
    tempDirs.push(root);
    const file = join(root, "state.json");

    await atomicWriteJson(file, { b: 2, a: 1 });

    expect(await readFile(file, "utf8")).toBe('{\n  "b": 2,\n  "a": 1\n}\n');
  });
});
