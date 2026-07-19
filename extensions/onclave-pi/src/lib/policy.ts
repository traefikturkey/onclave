import { readFile } from "node:fs/promises";

// Adapter-side origin policy. The file is re-read on every decision so
// explicit trust changes apply without restarting the session.
export type AdapterPolicy = {
  autoAcceptHosts: string[];
  delegatedAuthorityAgents: string[];
};

const EMPTY_POLICY: AdapterPolicy = {
  autoAcceptHosts: [],
  delegatedAuthorityAgents: [],
};

export async function loadAdapterPolicy(path: string): Promise<AdapterPolicy> {
  try {
    return parsePolicy(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch {
    return EMPTY_POLICY;
  }
}

export function isAutoAccepted(policy: AdapterPolicy, host: string): boolean {
  return policy.autoAcceptHosts.includes(host);
}

export function isDelegatedAuthorityAgent(policy: AdapterPolicy, agentId: string): boolean {
  return policy.delegatedAuthorityAgents.includes(agentId);
}

function parsePolicy(value: unknown): AdapterPolicy {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return EMPTY_POLICY;
  const record = value as Record<string, unknown>;
  return {
    autoAcceptHosts: stringArray(record.autoAcceptHosts),
    delegatedAuthorityAgents: stringArray(record.delegatedAuthorityAgents),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
