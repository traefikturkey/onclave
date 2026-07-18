import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// Trust file scaffold: entries load from /data/trust/authorized_keys so the
// posture carries over from v1, but enforcement beyond AMQP credentials is
// deferred (see v2 PRD Workstream C).
export type TrustEntry = {
  keyType: string;
  publicKey: string;
  comment?: string;
};

export async function loadTrustEntries(trustDir: string): Promise<TrustEntry[]> {
  await mkdir(trustDir, { recursive: true });
  let raw: string;
  try {
    raw = await readFile(join(trustDir, "authorized_keys"), "utf8");
  } catch {
    return [];
  }
  const entries: TrustEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2 || parts[0] !== "ssh-ed25519") continue;
    entries.push({
      keyType: parts[0],
      publicKey: parts[1],
      ...(parts.length > 2 ? { comment: parts.slice(2).join(" ") } : {}),
    });
  }
  return entries;
}
