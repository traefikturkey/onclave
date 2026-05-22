import { readFile } from "node:fs/promises";
import type { AuthorizedSshEd25519Key } from "./authorized-keys";
import { parseAuthorizedKeys } from "./authorized-keys";
import type { ComsLanIdentity } from "./identity";
import type { ComsLanPaths } from "./state";

export async function loadAuthorizedKeys(paths: ComsLanPaths): Promise<AuthorizedSshEd25519Key[]> {
  try {
    return parseAuthorizedKeys(await readFile(paths.authorizedKeys, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

export function formatAuthorizedKeyLine(identity: ComsLanIdentity): string {
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
