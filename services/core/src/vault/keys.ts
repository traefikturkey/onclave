import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const SSH_ED25519 = "ssh-ed25519";

export type AuthorizedKey = {
  keyId: string;
  publicKeyRaw: Buffer;
  comment: string | undefined;
};

function extractRawEd25519(blob: Buffer): Buffer | undefined {
  if (blob.length < 4) return undefined;
  const typeLength = blob.readUInt32BE(0);
  if (blob.length < 4 + typeLength + 4) return undefined;
  const keyType = blob.subarray(4, 4 + typeLength).toString("utf8");
  if (keyType !== SSH_ED25519) return undefined;
  const keyLength = blob.readUInt32BE(4 + typeLength);
  const start = 4 + typeLength + 4;
  if (keyLength !== 32 || blob.length < start + keyLength) return undefined;
  return blob.subarray(start, start + keyLength);
}

export function computeKeyId(blob: Buffer): string {
  const digest = createHash("sha256").update(blob).digest("hex");
  return `SHA256:${digest.slice(0, 16)}`;
}

export function parseAuthorizedKeyLine(line: string): AuthorizedKey | undefined {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return undefined;
  const match = /^ssh-ed25519\s+(\S+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return undefined;
  const keyData = match[1];
  if (keyData === undefined) return undefined;
  if (!/^[A-Za-z0-9+/=]+$/.test(keyData)) return undefined;
  const blob = Buffer.from(keyData, "base64");
  const raw = extractRawEd25519(blob);
  if (raw === undefined) return undefined;
  return { keyId: computeKeyId(blob), publicKeyRaw: raw, comment: match[2] };
}

/**
 * Manages authorized SSH public keys.
 *
 * Parity contract: accepts an authorized_keys file or a directory containing
 * an authorized_keys file plus individual `*.pub` files. Only ed25519 keys
 * are stored. Key ids are `SHA256:` plus the first 16 hex characters of the
 * SHA-256 digest of the SSH wire-format key blob, matching both the Python
 * server and the unmodified dotfiles client signer.
 */
export class KeyStore {
  private readonly keysPath: string;
  private keys = new Map<string, Buffer>();

  constructor(keysPath: string) {
    this.keysPath = keysPath;
    this.loadKeys();
  }

  private loadKeys(): void {
    if (!existsSync(this.keysPath)) return;
    const stats = statSync(this.keysPath);
    if (stats.isFile()) {
      this.loadAuthorizedKeysFile(this.keysPath);
      return;
    }
    if (!stats.isDirectory()) return;
    const authKeys = join(this.keysPath, "authorized_keys");
    if (existsSync(authKeys)) {
      this.loadAuthorizedKeysFile(authKeys);
    }
    for (const entry of readdirSync(this.keysPath)) {
      if (!entry.endsWith(".pub")) continue;
      this.storeLine(readFileSync(join(this.keysPath, entry), "utf8").trim());
    }
  }

  private loadAuthorizedKeysFile(path: string): void {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      this.storeLine(line);
    }
  }

  private storeLine(line: string): void {
    const parsed = parseAuthorizedKeyLine(line);
    if (parsed !== undefined) {
      this.keys.set(parsed.keyId, parsed.publicKeyRaw);
    }
  }

  getKey(keyId: string): Buffer | undefined {
    return this.keys.get(keyId);
  }

  listKeyIds(): string[] {
    return [...this.keys.keys()];
  }

  reload(): void {
    this.keys.clear();
    this.loadKeys();
  }
}
