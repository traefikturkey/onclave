import { createHash } from "node:crypto";

export type AuthorizedSshEd25519Key = {
  type: "ssh-ed25519";
  publicKeyBytes: Uint8Array;
  fingerprint: string;
  comment: string;
  lineNumber: number;
};

const SSH_ED25519 = "ssh-ed25519";
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseAuthorizedKeys(contents: string): AuthorizedSshEd25519Key[] {
  const keys: AuthorizedSshEd25519Key[] = [];
  const lines = contents.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0 || line.startsWith("#")) continue;
    keys.push(parseSshEd25519PublicKeyLine(line, index + 1));
  }

  return keys;
}

export function parseSshEd25519PublicKeyLine(
  line: string,
  lineNumber: number
): AuthorizedSshEd25519Key {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith("#")) {
    throw new Error(`line ${lineNumber}: no authorized key found`);
  }

  const parts = trimmed.split(/\s+/);
  const keyTypeIndex = parts.findIndex((part) => part === SSH_ED25519 || part.startsWith("ssh-"));

  if (keyTypeIndex === -1) {
    throw new Error(`line ${lineNumber}: authorized_keys options are not supported in v1`);
  }
  if (keyTypeIndex > 0) {
    throw new Error(`line ${lineNumber}: authorized_keys options are not supported in v1`);
  }

  const keyType = parts[0];
  if (keyType !== SSH_ED25519) {
    throw new Error(`line ${lineNumber}: unsupported authorized key type ${keyType}`);
  }

  const encoded = parts[1];
  if (!encoded || !isValidBase64(encoded)) {
    throw new Error(`line ${lineNumber}: invalid ssh-ed25519 key payload`);
  }

  const blob = Buffer.from(encoded, "base64");
  const parsed = parseOpenSshEd25519Blob(blob, lineNumber);
  const comment = parts.slice(2).join(" ");

  return {
    type: SSH_ED25519,
    publicKeyBytes: parsed.publicKeyBytes,
    fingerprint: fingerprintOpenSshBlob(blob),
    comment,
    lineNumber,
  };
}

function isValidBase64(value: string): boolean {
  if (!BASE64_RE.test(value) || value.length % 4 === 1) return false;
  try {
    const decoded = Buffer.from(value, "base64");
    return decoded.length > 0;
  } catch {
    return false;
  }
}

function parseOpenSshEd25519Blob(
  blob: Buffer,
  lineNumber: number
): { publicKeyBytes: Uint8Array } {
  let offset = 0;
  const typeResult = readSshString(blob, offset, lineNumber, "key type");
  offset = typeResult.nextOffset;
  const innerType = typeResult.value.toString("utf8");
  if (innerType !== SSH_ED25519) {
    throw new Error(`line ${lineNumber}: invalid inner key type ${innerType}`);
  }

  const keyResult = readSshString(blob, offset, lineNumber, "public key");
  offset = keyResult.nextOffset;
  if (keyResult.value.length !== 32) {
    throw new Error(`line ${lineNumber}: ssh-ed25519 public key must be 32 bytes`);
  }
  if (offset !== blob.length) {
    throw new Error(`line ${lineNumber}: invalid ssh-ed25519 key payload trailing data`);
  }

  return { publicKeyBytes: new Uint8Array(keyResult.value) };
}

function readSshString(
  blob: Buffer,
  offset: number,
  lineNumber: number,
  label: string
): { value: Buffer; nextOffset: number } {
  if (offset + 4 > blob.length) {
    throw new Error(`line ${lineNumber}: invalid ssh-ed25519 key payload while reading ${label}`);
  }

  const length = blob.readUInt32BE(offset);
  const start = offset + 4;
  const end = start + length;
  if (end > blob.length) {
    throw new Error(`line ${lineNumber}: invalid ssh-ed25519 key payload while reading ${label}`);
  }

  return { value: blob.subarray(start, end), nextOffset: end };
}

function fingerprintOpenSshBlob(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}
