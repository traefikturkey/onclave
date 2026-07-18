import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { platform, tmpdir } from "node:os";
import { loadOrCreateTlsMaterial } from "../src/lib/tls";
import { getOnclavePaths } from "../src/lib/state";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("loadOrCreateTlsMaterial", () => {
  it("generates and persists TLS material under the onclave root", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-tls-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);
    let generations = 0;

    const material = await loadOrCreateTlsMaterial(paths, async () => {
      generations += 1;
      return {
        cert: pem("CERTIFICATE", "test-cert"),
        key: pem("PRIVATE KEY", "test-key"),
      };
    });

    expect(generations).toBe(1);
    expect(material.cert).toContain("BEGIN CERTIFICATE");
    expect(material.key).toContain("BEGIN PRIVATE KEY"); // pragma: allowlist secret
    expect(await readFile(join(root, "tls.cert.pem"), "utf8")).toBe(material.cert);
    expect(await readFile(join(root, "tls.key.pem"), "utf8")).toBe(material.key);
    expect(join(root, "tls.key.pem")).not.toContain(".ssh");
  });

  it("reuses existing TLS material without regenerating", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-tls-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);

    const first = await loadOrCreateTlsMaterial(paths, async () => ({
      cert: pem("CERTIFICATE", "first-cert"),
      key: pem("PRIVATE KEY", "first-key"),
    }));
    const second = await loadOrCreateTlsMaterial(paths, async () => {
      throw new Error("should not regenerate");
    });

    expect(second).toEqual(first);
  });

  it("uses restrictive permissions for the private key where supported", async () => {
    const root = await mkdtemp(join(tmpdir(), "onclave-tls-"));
    tempDirs.push(root);
    const paths = getOnclavePaths(root);

    await loadOrCreateTlsMaterial(paths, async () => ({
      cert: pem("CERTIFICATE", "test-cert"),
      key: pem("PRIVATE KEY", "test-key"),
    }));

    const mode = (await stat(join(root, "tls.key.pem"))).mode & 0o777;
    if (platform() !== "win32") {
      expect(mode & 0o077).toBe(0);
    } else {
      expect(mode).toBeGreaterThan(0);
    }
  });
});

function pem(label: string, body: string): string {
  return `-----${"BEGIN"} ${label}-----\n${body}\n-----${"END"} ${label}-----\n`;
}
