import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type OnclavePaths = {
  root: string;
  authorizedKeys: string;
  auditLog: string;
  config: string;
  hubState: string;
  hubLock: string;
  identity: string;
  privateKey: string;
  tlsCert: string;
  tlsKey: string;
  runtimeDir: string;
};

export function getOnclavePaths(root: string): OnclavePaths {
  return {
    root,
    authorizedKeys: join(root, "authorized_keys"),
    auditLog: join(root, "audit.log.jsonl"),
    config: join(root, "config.json"),
    hubState: join(root, "hub.json"),
    hubLock: join(root, "hub.lock"),
    identity: join(root, "identity.json"),
    privateKey: join(root, "identity.key"),
    tlsCert: join(root, "tls.cert.pem"),
    tlsKey: join(root, "tls.key.pem"),
    runtimeDir: join(root, "runtime"),
  };
}

export async function ensureOnclaveRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await mkdir(join(root, "runtime"), { recursive: true });
}

export async function atomicWriteJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, content, { mode });
  await rename(tempPath, path);
}
