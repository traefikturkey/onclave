import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// Atomic JSON write ported from v1 onclave-comms state.ts.
export async function atomicWriteJson(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(tempPath, content, { mode });
  await rename(tempPath, path);
}
