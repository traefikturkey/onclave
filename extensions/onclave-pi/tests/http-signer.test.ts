import { createHash, createPrivateKey, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRequestSignerFromOpenSsh, loadRequestSigner } from "../src/lib/http-signer";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PUBLIC_KEY_OFFSET = 12;
const OPENSSH_PEM_LABEL = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const SSH_ED25519 = "ssh-ed25519";

let tempDir: string | undefined;

type TestKey = {
  privateKey: KeyObject;
  publicKey: Buffer;
  openssh: Buffer;
};

function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function publicBlob(publicKey: Buffer, keyType = SSH_ED25519): Buffer {
  return Buffer.concat([sshString(keyType), sshString(publicKey)]);
}

function openSshPrivateKey(seed: Buffer, publicKey: Buffer, cipherName = "none", keyType = SSH_ED25519): Buffer {
  const check = 0x11223344;
  let privateBlob = Buffer.concat([
    uint32(check),
    uint32(check),
    sshString(keyType),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString("test@example"),
  ]);
  const paddingLength = (8 - (privateBlob.length % 8)) % 8;
  if (paddingLength > 0) {
    privateBlob = Buffer.concat([privateBlob, Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1))]);
  }
  const payload = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "utf8"),
    sshString(cipherName),
    sshString(cipherName === "none" ? "none" : "bcrypt"),
    sshString(""),
    uint32(1),
    sshString(publicBlob(publicKey, keyType)),
    sshString(privateBlob),
  ]);
  const base64 = payload.toString("base64");
  const wrapped = base64.match(/.{1,70}/g)?.join("\n") ?? base64;
  return Buffer.from(`-----BEGIN ${OPENSSH_PEM_LABEL}-----\n${wrapped}\n-----END ${OPENSSH_PEM_LABEL}-----\n`, "utf8");
}

function testKey(): TestKey {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PUBLIC_KEY_OFFSET);
  return { privateKey, publicKey, openssh: openSshPrivateKey(seed, publicKey) };
}

function signatureBase(headers: Record<string, string>, method: string, path: string, authority: string): string {
  const signatureInput = headers["signature-input"];
  if (signatureInput === undefined) throw new Error("signature-input is missing");
  const params = signatureInput.slice("sig1=".length);
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${authority}`];
  if (headers["content-digest"] !== undefined) {
    lines.push(`"content-digest": ${headers["content-digest"]}`);
  }
  lines.push(`"@signature-params": ${params}`);
  return lines.join("\n");
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("OpenSSH ed25519 request signer", () => {
  it("converts an unencrypted OpenSSH seed to a Node key and matches the server key id contract", () => {
    const key = testKey();
    const signer = createRequestSignerFromOpenSsh(key.openssh);
    const expectedKeyId = `SHA256:${createHash("sha256").update(publicBlob(key.publicKey)).digest("hex").slice(0, 16)}`;
    expect(signer.keyId).toBe(expectedKeyId);

    const body = Buffer.from('{"op":"list_agents"}', "utf8");
    const headers = signer.signRequest("POST", "/api/v1/agents/rpc", "onclave.example", body);
    expect(headers["content-digest"]).toBe(`sha-256=:${createHash("sha256").update(body).digest("base64")}:`);
    expect(headers["signature-input"]).toContain(`keyid="${expectedKeyId}"`);
    const signature = headers.signature.split(":")[1];
    expect(signature).toBeDefined();
    expect(
      cryptoVerify(
        null,
        Buffer.from(signatureBase(headers, "POST", "/api/v1/agents/rpc", "onclave.example"), "utf8"),
        key.privateKey,
        Buffer.from(signature ?? "", "base64")
      )
    ).toBe(true);
  });

  it("rejects encrypted and non-ed25519 OpenSSH private keys clearly", () => {
    const key = testKey();
    expect(() => createRequestSignerFromOpenSsh(openSshPrivateKey(randomBytes(32), key.publicKey, "aes256-ctr"))).toThrow(
      "is encrypted"
    );
    expect(() => createRequestSignerFromOpenSsh(openSshPrivateKey(randomBytes(32), key.publicKey, "none", "ssh-rsa"))).toThrow(
      "ed25519"
    );
  });

  it("reports a missing signing key without falling back to another format", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "onclave-http-signer-"));
    await expect(loadRequestSigner(join(tempDir, "missing"))).rejects.toThrow("Onclave signing key is missing");
  });
});
