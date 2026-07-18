import { readFile } from "node:fs/promises";

// Adapter-side origin policy: cross-host requests confirm by default, with
// per-host auto-accept as explicit opt-in. The file is re-read on every
// decision so policy changes apply without session restarts.
export type AdapterPolicy = {
  autoAcceptHosts: string[];
};

export async function loadAdapterPolicy(path: string): Promise<AdapterPolicy> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return { autoAcceptHosts: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { autoAcceptHosts: [] };
    const hosts = (parsed as { autoAcceptHosts?: unknown }).autoAcceptHosts;
    if (!Array.isArray(hosts)) return { autoAcceptHosts: [] };
    return { autoAcceptHosts: hosts.filter((host) => typeof host === "string") };
  } catch {
    return { autoAcceptHosts: [] };
  }
}

export function isAutoAccepted(policy: AdapterPolicy, host: string): boolean {
  return policy.autoAcceptHosts.includes(host);
}
