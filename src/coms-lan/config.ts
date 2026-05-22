import { readFile } from "node:fs/promises";
import type { ComsLanPaths } from "./state";
import { atomicWriteJson } from "./state";

export type StaticPeerConfig = {
  name?: string;
  nodeId: string;
  hubInstanceId: string;
  endpoint: string;
};

export type ComsLanConfig = {
  version: 1;
  staticPeers: StaticPeerConfig[];
};

export const DEFAULT_COMS_LAN_CONFIG: ComsLanConfig = {
  version: 1,
  staticPeers: [],
};

export async function loadComsLanConfig(paths: ComsLanPaths): Promise<ComsLanConfig> {
  try {
    const parsed = JSON.parse(await readFile(paths.config, "utf8")) as unknown;
    return parseComsLanConfig(parsed);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return DEFAULT_COMS_LAN_CONFIG;
    if (error instanceof SyntaxError) throw new Error(`invalid coms-lan config JSON: ${error.message}`);
    throw error;
  }
}

export async function writeComsLanConfig(paths: ComsLanPaths, config: ComsLanConfig): Promise<void> {
  await atomicWriteJson(paths.config, parseComsLanConfig(config));
}

export function parseComsLanConfig(value: unknown): ComsLanConfig {
  if (!value || typeof value !== "object") {
    throw new Error("coms-lan config must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) throw new Error("coms-lan config version must be 1");
  if (!Array.isArray(record.staticPeers)) throw new Error("coms-lan config staticPeers must be an array");

  const names = new Set<string>();
  const peers = record.staticPeers.map((peer, index) => parseStaticPeer(peer, index));
  for (const peer of peers) {
    if (!peer.name) continue;
    if (names.has(peer.name)) throw new Error(`duplicate static peer name: ${peer.name}`);
    names.add(peer.name);
  }

  return { version: 1, staticPeers: peers };
}

export function findStaticPeer(config: ComsLanConfig, name: string): StaticPeerConfig | null {
  return config.staticPeers.find((peer) => peer.name === name) ?? null;
}

function parseStaticPeer(value: unknown, index: number): StaticPeerConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`staticPeers[${index}] must be an object`);
  }
  const record = value as Record<string, unknown>;
  const name = optionalNonEmptyString(record.name, `staticPeers[${index}].name`);
  const nodeId = requiredNonEmptyString(record.nodeId, `staticPeers[${index}].nodeId`);
  const hubInstanceId = requiredNonEmptyString(record.hubInstanceId, `staticPeers[${index}].hubInstanceId`);
  const endpoint = requiredNonEmptyString(record.endpoint, `staticPeers[${index}].endpoint`);
  if (!/^wss:\/\/[^\s]+\/v1\/hub$/.test(endpoint)) {
    throw new Error(`staticPeers[${index}].endpoint must be a wss://.../v1/hub URL`);
  }
  return name ? { name, nodeId, hubInstanceId, endpoint } : { nodeId, hubInstanceId, endpoint };
}

function requiredNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredNonEmptyString(value, path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
