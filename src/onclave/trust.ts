import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { parseAuthorizedKeys, parseSshEd25519PublicKeyLine } from "./authorized-keys";
import type { OnclaveIdentity } from "./identity";
import type { OnclavePaths } from "./state";

export type AddAuthorizedKeyResult = {
  key: AuthorizedSshEd25519Key;
  added: boolean;
};

export async function loadAuthorizedKeys(paths: OnclavePaths): Promise<AuthorizedSshEd25519Key[]> {
  try {
    return parseAuthorizedKeys(await readFile(paths.authorizedKeys, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

export async function addAuthorizedKeyLine(paths: OnclavePaths, line: string): Promise<AddAuthorizedKeyResult> {
  const key = parseSshEd25519PublicKeyLine(line, 1);
  const existing = await loadAuthorizedKeys(paths);
  const publicKeyHex = Buffer.from(key.publicKeyBytes).toString("hex");
  const duplicate = existing.some((item) => Buffer.from(item.publicKeyBytes).toString("hex") === publicKeyHex);
  if (duplicate) return { key, added: false };

  await mkdir(dirname(paths.authorizedKeys), { recursive: true });
  await appendFile(paths.authorizedKeys, `${line.trim()}\n`, "utf8");
  return { key, added: true };
}

export function formatAuthorizedKeyLine(identity: OnclaveIdentity): string {
  const publicKey = Buffer.from(identity.publicKey, "hex");
  if (publicKey.length !== 32) {
    throw new Error("identity public key must be 32 bytes");
  }
  const payload = Buffer.concat([
    encodeSshString(Buffer.from("ssh-ed25519", "utf8")),
    encodeSshString(publicKey),
  ]).toString("base64");
  return `ssh-ed25519 ${payload} ${identity.nodeId}`;
}

function encodeSshString(value: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length, 0);
  return Buffer.concat([length, value]);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
