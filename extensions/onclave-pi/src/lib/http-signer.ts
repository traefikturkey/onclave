import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign, type KeyObject } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const OPENSSH_MAGIC = Buffer.from("openssh-key-v1\0", "utf8");
const OPENSSH_PEM_LABEL = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const OPENSSH_PEM_BEGIN = `-----BEGIN ${OPENSSH_PEM_LABEL}-----`;
const OPENSSH_PEM_END = `-----END ${OPENSSH_PEM_LABEL}-----`;
const SSH_ED25519 = "ssh-ed25519";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PUBLIC_KEY_OFFSET = 12;

export const DEFAULT_SIGNING_KEY_PATH = join(homedir(), ".ssh", "id_ed25519");

export type SignedRequestHeaders = Record<string, string>;

export type RequestSigner = {
  keyId: string;
  signRequest: (method: string, path: string, authority: string, body?: Buffer) => SignedRequestHeaders;
};

type SshReader = {
  bytes: Buffer;
  offset: number;
};

function readUint32(reader: SshReader, context: string): number {
  if (reader.offset + 4 > reader.bytes.length) {
    throw new Error(`Onclave signing key is malformed: missing ${context}`);
  }
  const value = reader.bytes.readUInt32BE(reader.offset);
  reader.offset += 4;
  return value;
}

function readString(reader: SshReader, context: string): Buffer {
  const length = readUint32(reader, `${context} length`);
  const end = reader.offset + length;
  if (end > reader.bytes.length || end < reader.offset) {
    throw new Error(`Onclave signing key is malformed: invalid ${context}`);
  }
  const value = reader.bytes.subarray(reader.offset, end);
  reader.offset = end;
  return value;
}

function readUtf8String(reader: SshReader, context: string): string {
  return readString(reader, context).toString("utf8");
}

function parsePem(input: Buffer): Buffer {
  const text = input.toString("utf8").trim();
  if (!text.startsWith(OPENSSH_PEM_BEGIN) || !text.endsWith(OPENSSH_PEM_END)) {
    throw new Error("Onclave signing key must be an unencrypted OpenSSH ed25519 private key");
  }
  const encoded = text.slice(OPENSSH_PEM_BEGIN.length, -OPENSSH_PEM_END.length).replace(/\s/g, "");
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Onclave signing key is malformed: invalid OpenSSH base64 data");
  }
  return Buffer.from(encoded, "base64");
}

function parseOpenSshEd25519Seed(input: Buffer): { seed: Buffer; publicKey: Buffer } {
  const payload = parsePem(input);
  if (payload.length < OPENSSH_MAGIC.length || !payload.subarray(0, OPENSSH_MAGIC.length).equals(OPENSSH_MAGIC)) {
    throw new Error("Onclave signing key is malformed: invalid OpenSSH key header");
  }

  const reader: SshReader = { bytes: payload, offset: OPENSSH_MAGIC.length };
  const cipherName = readUtf8String(reader, "cipher name");
  const kdfName = readUtf8String(reader, "KDF name");
  const kdfOptions = readString(reader, "KDF options");
  if (cipherName !== "none" || kdfName !== "none" || kdfOptions.length !== 0) {
    throw new Error("Onclave signing key is encrypted; an unencrypted OpenSSH ed25519 private key is required");
  }

  const keyCount = readUint32(reader, "key count");
  if (keyCount !== 1) {
    throw new Error("Onclave signing key must contain exactly one ed25519 key");
  }
  const publicBlob = readString(reader, "public key");
  const privateBlob = readString(reader, "private key");
  if (reader.offset !== reader.bytes.length) {
    throw new Error("Onclave signing key is malformed: trailing OpenSSH data");
  }

  const publicReader: SshReader = { bytes: publicBlob, offset: 0 };
  const publicType = readUtf8String(publicReader, "public key type");
  const publicKey = readString(publicReader, "public key bytes");
  if (publicReader.offset !== publicBlob.length || publicType !== SSH_ED25519 || publicKey.length !== 32) {
    throw new Error("Onclave signing key must be an OpenSSH ed25519 private key");
  }

  const privateReader: SshReader = { bytes: privateBlob, offset: 0 };
  const checkOne = readUint32(privateReader, "private key check value");
  const checkTwo = readUint32(privateReader, "private key check value");
  if (checkOne !== checkTwo) {
    throw new Error("Onclave signing key is malformed: private key check values differ");
  }
  const privateType = readUtf8String(privateReader, "private key type");
  const privatePublicKey = readString(privateReader, "private key public bytes");
  const privateBytes = readString(privateReader, "private key bytes");
  readString(privateReader, "private key comment");
  if (privateType !== SSH_ED25519 || privatePublicKey.length !== 32 || privateBytes.length !== 64) {
    throw new Error("Onclave signing key must be an OpenSSH ed25519 private key");
  }
  const seed = privateBytes.subarray(0, 32);
  const embeddedPublicKey = privateBytes.subarray(32);
  if (!publicKey.equals(privatePublicKey) || !publicKey.equals(embeddedPublicKey)) {
    throw new Error("Onclave signing key is malformed: public key does not match private key");
  }
  for (let expected = 1; privateReader.offset < privateBlob.length; expected += 1) {
    if (privateBlob[privateReader.offset] !== expected) {
      throw new Error("Onclave signing key is malformed: invalid OpenSSH padding");
    }
    privateReader.offset += 1;
  }
  return { seed, publicKey };
}

function sshPublicKeyBlob(publicKey: Buffer): Buffer {
  const type = Buffer.from(SSH_ED25519, "utf8");
  const typeLength = Buffer.alloc(4);
  const keyLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(type.length, 0);
  keyLength.writeUInt32BE(publicKey.length, 0);
  return Buffer.concat([typeLength, type, keyLength, publicKey]);
}

function keyIdFromPublicKey(publicKey: Buffer): string {
  return `SHA256:${createHash("sha256").update(sshPublicKeyBlob(publicKey)).digest("hex").slice(0, 16)}`;
}

function createEd25519PrivateKey(seed: Buffer, expectedPublicKey: Buffer): KeyObject {
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Onclave signing key did not produce an ed25519 private key");
  }
  const derivedPublicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const rawPublicKey = derivedPublicKey.subarray(ED25519_SPKI_PUBLIC_KEY_OFFSET);
  if (!rawPublicKey.equals(expectedPublicKey)) {
    throw new Error("Onclave signing key is malformed: ed25519 seed does not match public key");
  }
  return privateKey;
}

export function createRequestSignerFromOpenSsh(input: Buffer): RequestSigner {
  const { seed, publicKey } = parseOpenSshEd25519Seed(input);
  const privateKey = createEd25519PrivateKey(seed, publicKey);
  const keyId = keyIdFromPublicKey(publicKey);
  return {
    keyId,
    signRequest: (method, path, authority, body) => signRequest(privateKey, keyId, method, path, authority, body),
  };
}

function signRequest(
  privateKey: KeyObject,
  keyId: string,
  method: string,
  path: string,
  authority: string,
  body?: Buffer
): SignedRequestHeaders {
  const components = ['"@method"', '"@path"', '"@authority"'];
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${authority}`];
  let contentDigest: string | undefined;
  if (body !== undefined && body.length > 0) {
    components.push('"content-digest"');
    contentDigest = `sha-256=:${createHash("sha256").update(body).digest("base64")}:`;
    lines.push(`"content-digest": ${contentDigest}`);
  }
  const signatureParams = `(${components.join(" ")});keyid="${keyId}";alg="ed25519";created=${Math.floor(Date.now() / 1000)}`;
  lines.push(`"@signature-params": ${signatureParams}`);
  const signature = cryptoSign(null, Buffer.from(lines.join("\n"), "utf8"), privateKey).toString("base64");
  return {
    "signature-input": `sig1=${signatureParams}`,
    signature: `sig1=:${signature}:`,
    ...(contentDigest === undefined ? {} : { "content-digest": contentDigest }),
  };
}

export async function loadDefaultRequestSigner(): Promise<RequestSigner> {
  return loadRequestSigner(DEFAULT_SIGNING_KEY_PATH);
}

export async function loadRequestSigner(path: string): Promise<RequestSigner> {
  let key: Buffer;
  try {
    key = await readFile(path);
  } catch (error) {
    if (isMissingFileError(error)) {
      throw new Error(`Onclave signing key is missing: ${path}`);
    }
    throw new Error(`Onclave signing key cannot be read: ${path}`);
  }
  return createRequestSignerFromOpenSsh(key);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
