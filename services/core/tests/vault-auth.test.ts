import { generateKeyPairSync, createHash, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError } from "../src/vault/errors";
import { KeyStore, computeKeyId, parseAuthorizedKeyLine } from "../src/vault/keys";
import { verifySignedRequest, type SignedRequestInput } from "../src/vault/signature";

const SSH_ED25519 = "ssh-ed25519";

type TestKey = {
  privateKey: KeyObject;
  keyId: string;
  authorizedKeysLine: string;
};

function sshBlobFromRaw(rawPublicKey: Buffer): Buffer {
  const keyType = Buffer.from(SSH_ED25519, "utf8");
  const typeLength = Buffer.alloc(4);
  typeLength.writeUInt32BE(keyType.length, 0);
  const keyLength = Buffer.alloc(4);
  keyLength.writeUInt32BE(rawPublicKey.length, 0);
  return Buffer.concat([typeLength, keyType, keyLength, rawPublicKey]);
}

function makeTestKey(comment = "operator@example"): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
  const blob = sshBlobFromRaw(rawPublicKey);
  return {
    privateKey,
    keyId: computeKeyId(blob),
    authorizedKeysLine: `${SSH_ED25519} ${blob.toString("base64")} ${comment}`,
  };
}

/** Mirrors the unmodified dotfiles client signer (tools/menos-youtube/signing.py). */
function signRequest(
  key: TestKey,
  method: string,
  path: string,
  host: string,
  body?: Buffer,
  overrides: { created?: number; alg?: string; keyId?: string } = {},
): Record<string, string> {
  const created = overrides.created ?? Math.floor(Date.now() / 1000);
  const keyId = overrides.keyId ?? key.keyId;
  const alg = overrides.alg ?? "ed25519";

  const components = ['"@method"', '"@path"', '"@authority"'];
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${host}`];

  let contentDigest: string | undefined;
  if (body !== undefined) {
    components.push('"content-digest"');
    const digest = createHash("sha256").update(body).digest("base64");
    contentDigest = `sha-256=:${digest}:`;
    lines.push(`"content-digest": ${contentDigest}`);
  }

  const sigParams = `(${components.join(" ")});keyid="${keyId}";alg="${alg}";created=${created}`;
  lines.push(`"@signature-params": ${sigParams}`);

  const signatureBase = lines.join("\n");
  const signature = cryptoSign(null, Buffer.from(signatureBase, "utf8"), key.privateKey);

  const headers: Record<string, string> = {
    "signature-input": `sig1=${sigParams}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
  if (contentDigest !== undefined) {
    headers["content-digest"] = contentDigest;
  }
  return headers;
}

function makeRequest(
  key: TestKey,
  method: string,
  path: string,
  host: string,
  body?: Buffer,
  overrides: { created?: number; alg?: string; keyId?: string } = {},
): SignedRequestInput {
  const headers = signRequest(key, method, path, host, body, overrides);
  const request: SignedRequestInput = {
    method,
    path,
    headers: { host, ...headers },
  };
  if (body !== undefined) request.body = body;
  return request;
}

function storeWithKeys(...lines: string[]): KeyStore {
  const dir = mkdtempSync(join(tmpdir(), "vault-keys-"));
  writeFileSync(join(dir, "authorized_keys"), lines.join("\n"), "utf8");
  return new KeyStore(join(dir, "authorized_keys"));
}

describe("KeyStore", () => {
  it("parses authorized_keys lines and skips comments, blanks, and non-ed25519 keys", () => {
    const key = makeTestKey();
    const store = storeWithKeys(
      "# a comment",
      "",
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAgQC7 nobody@example",
      key.authorizedKeysLine,
    );
    expect(store.listKeyIds()).toEqual([key.keyId]);
    expect(store.getKey(key.keyId)).toBeDefined();
  });

  it("loads a directory with authorized_keys plus individual .pub files", () => {
    const fileKey = makeTestKey("file@example");
    const pubKey = makeTestKey("pub@example");
    const dir = mkdtempSync(join(tmpdir(), "vault-keys-dir-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "authorized_keys"), `${fileKey.authorizedKeysLine}\n`, "utf8");
    writeFileSync(join(dir, "operator.pub"), `${pubKey.authorizedKeysLine}\n`, "utf8");
    const store = new KeyStore(dir);
    expect(new Set(store.listKeyIds())).toEqual(new Set([fileKey.keyId, pubKey.keyId]));
  });

  it("reload picks up newly added keys", () => {
    const first = makeTestKey("first@example");
    const second = makeTestKey("second@example");
    const dir = mkdtempSync(join(tmpdir(), "vault-keys-reload-"));
    const path = join(dir, "authorized_keys");
    writeFileSync(path, `${first.authorizedKeysLine}\n`, "utf8");
    const store = new KeyStore(path);
    expect(store.listKeyIds()).toEqual([first.keyId]);
    writeFileSync(path, `${first.authorizedKeysLine}\n${second.authorizedKeysLine}\n`, "utf8");
    store.reload();
    expect(new Set(store.listKeyIds())).toEqual(new Set([first.keyId, second.keyId]));
  });

  it("returns no keys for a missing path", () => {
    const store = new KeyStore(join(tmpdir(), "vault-keys-missing", "authorized_keys"));
    expect(store.listKeyIds()).toEqual([]);
  });

  it("rejects malformed authorized_keys lines", () => {
    expect(parseAuthorizedKeyLine("not a key")).toBeUndefined();
    expect(parseAuthorizedKeyLine("ssh-ed25519 !!!invalid-base64!!!")).toBeUndefined();
    expect(
      parseAuthorizedKeyLine(`ssh-ed25519 ${Buffer.from("junk").toString("base64")}`),
    ).toBeUndefined();
  });
});

describe("verifySignedRequest", () => {
  it("accepts a signed GET request and returns the key id", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request = makeRequest(key, "GET", "/api/v1/content", "vault.example");
    expect(verifySignedRequest(request, store)).toBe(key.keyId);
  });

  it("accepts a signed path that includes a query string", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const path = "/api/v1/content?content_type=youtube&limit=100&offset=0&exclude_tags=";
    const request = makeRequest(key, "GET", path, "vault.example");
    expect(verifySignedRequest(request, store)).toBe(key.keyId);
  });

  it("accepts a signed POST with a content digest", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const body = Buffer.from(JSON.stringify({ query: "test", limit: 5 }), "utf8");
    const request = makeRequest(key, "POST", "/api/v1/search", "vault.example", body);
    expect(verifySignedRequest(request, store)).toBe(key.keyId);
  });

  it("rejects a tampered body", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const body = Buffer.from(JSON.stringify({ query: "test", limit: 5 }), "utf8");
    const request = makeRequest(key, "POST", "/api/v1/search", "vault.example", body);
    request.body = Buffer.from(JSON.stringify({ query: "evil", limit: 5 }), "utf8");
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: "Invalid signature" }),
    );
  });

  it("rejects a tampered path", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request = makeRequest(key, "GET", "/api/v1/content/abc", "vault.example");
    request.path = "/api/v1/content/def";
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: "Invalid signature" }),
    );
  });

  it("rejects unknown keys", () => {
    const trusted = makeTestKey("trusted@example");
    const untrusted = makeTestKey("untrusted@example");
    const store = storeWithKeys(trusted.authorizedKeysLine);
    const request = makeRequest(untrusted, "GET", "/api/v1/content", "vault.example");
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: `Unknown key: ${untrusted.keyId}` }),
    );
  });

  it("rejects signatures outside the validity window", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const stale = Math.floor(Date.now() / 1000) - 301;
    const request = makeRequest(key, "GET", "/api/v1/content", "vault.example", undefined, {
      created: stale,
    });
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: "Signature expired or from future" }),
    );
  });

  it("rejects unsupported algorithms", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request = makeRequest(key, "GET", "/api/v1/content", "vault.example", undefined, {
      alg: "rsa-v1_5-sha256",
    });
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: "Unsupported algorithm: rsa-v1_5-sha256" }),
    );
  });

  it("rejects requests without signature headers", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request: SignedRequestInput = {
      method: "GET",
      path: "/api/v1/content",
      headers: { host: "vault.example" },
    };
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 401, message: "Missing signature headers" }),
    );
  });

  it("rejects malformed signature-input headers", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request: SignedRequestInput = {
      method: "GET",
      path: "/api/v1/content",
      headers: {
        host: "vault.example",
        "signature-input": "sig1=@method",
        signature: "sig1=:AAAA:",
      },
    };
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 400, message: "Invalid signature-input format" }),
    );
  });

  it("rejects malformed signature headers", () => {
    const key = makeTestKey();
    const store = storeWithKeys(key.authorizedKeysLine);
    const request = makeRequest(key, "GET", "/api/v1/content", "vault.example");
    request.headers.signature = "sig1=?not-base64?";
    expect(() => verifySignedRequest(request, store)).toThrowError(
      expect.objectContaining({ status: 400, message: "Invalid signature format" }),
    );
  });

  it("throws HttpError instances usable by the HTTP layer", () => {
    const store = storeWithKeys(makeTestKey().authorizedKeysLine);
    const request: SignedRequestInput = {
      method: "GET",
      path: "/api/v1/content",
      headers: { host: "vault.example" },
    };
    try {
      verifySignedRequest(request, store);
      expect.unreachable("verification must fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
    }
  });
});
