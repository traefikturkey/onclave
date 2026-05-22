import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { keygenAsync } from "@noble/ed25519";
import type { ComsLanPaths } from "./state";
import { atomicWriteJson, ensureComsLanRoot } from "./state";

export type ComsLanIdentity = {
  version: 1;
  nodeId: string;
  publicKey: string;
  privateKeyPath: string;
  createdAt: string;
};

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export async function loadOrCreateIdentity(paths: ComsLanPaths): Promise<ComsLanIdentity> {
  await ensureComsLanRoot(paths.root);

  const existing = await readIdentity(paths);
  if (existing) return existing;

  const keyPair = await keygenAsync();
  const identity: ComsLanIdentity = {
    version: 1,
    nodeId: `node_${ulid()}`,
    publicKey: bytesToHex(keyPair.publicKey),
    privateKeyPath: paths.privateKey,
    createdAt: new Date().toISOString(),
  };

  await writeFile(paths.privateKey, `${bytesToHex(keyPair.secretKey)}\n`, { mode: 0o600 });
  await atomicWriteJson(paths.identity, identity, 0o600);
  return identity;
}

export async function loadIdentityPrivateKeyHex(paths: ComsLanPaths): Promise<string> {
  const privateKeyHex = (await readFile(paths.privateKey, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(privateKeyHex)) {
    throw new Error("identity private key must be 32 bytes of hex");
  }
  return privateKeyHex.toLowerCase();
}

async function readIdentity(paths: ComsLanPaths): Promise<ComsLanIdentity | null> {
  try {
    const parsed = JSON.parse(await readFile(paths.identity, "utf8")) as unknown;
    if (!isIdentity(parsed)) return null;
    return parsed;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isIdentity(value: unknown): value is ComsLanIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.nodeId === "string" &&
    /^node_[0-9A-HJKMNP-TV-Z]{26}$/.test(record.nodeId) &&
    typeof record.publicKey === "string" &&
    /^[a-f0-9]{64}$/.test(record.publicKey) &&
    typeof record.privateKeyPath === "string" &&
    !record.privateKeyPath.includes(".ssh") &&
    typeof record.createdAt === "string"
  );
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function ulid(): string {
  const time = Date.now();
  const rand = randomBytes(10);
  let timeStr = "";
  let timestamp = time;
  for (let index = 9; index >= 0; index -= 1) {
    timeStr = CROCKFORD[timestamp % 32] + timeStr;
    timestamp = Math.floor(timestamp / 32);
  }

  let randStr = "";
  let bits = 0;
  let value = 0;
  for (const byte of rand) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      randStr += CROCKFORD[(value >> bits) & 31];
    }
  }

  return (timeStr + randStr).slice(0, 26);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
