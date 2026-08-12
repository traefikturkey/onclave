import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createVaultHttpServer,
  jsonResponse,
  rawResponse,
  type RouteRequest,
} from "../src/vault/http";
import { KeyStore, computeKeyId } from "../src/vault/keys";

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

function makeTestKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const rawPublicKey = Buffer.from(spki.subarray(spki.length - 32));
  const blob = sshBlobFromRaw(rawPublicKey);
  return {
    privateKey,
    keyId: computeKeyId(blob),
    authorizedKeysLine: `${SSH_ED25519} ${blob.toString("base64")} operator@example`,
  };
}

/** Mirrors the unmodified dotfiles client signer (tools/menos-youtube/signing.py). */
function signRequest(
  key: TestKey,
  method: string,
  path: string,
  host: string,
  body?: Buffer,
): Record<string, string> {
  const created = Math.floor(Date.now() / 1000);
  const components = ['"@method"', '"@path"', '"@authority"'];
  const lines = [`"@method": ${method}`, `"@path": ${path}`, `"@authority": ${host}`];

  let contentDigest: string | undefined;
  if (body !== undefined) {
    components.push('"content-digest"');
    const digest = createHash("sha256").update(body).digest("base64");
    contentDigest = `sha-256=:${digest}:`;
    lines.push(`"content-digest": ${contentDigest}`);
  }

  const signatureParams = `(${components.join(" ")});keyid="${key.keyId}";alg="ed25519";created=${created}`;
  lines.push(`"@signature-params": ${signatureParams}`);
  const signature = cryptoSign(null, Buffer.from(lines.join("\n"), "utf8"), key.privateKey);
  const headers: Record<string, string> = {
    "signature-input": `sig1=${signatureParams}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
  if (contentDigest !== undefined) headers["content-digest"] = contentDigest;
  return headers;
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server did not bind to TCP");
  return (address as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("vault HTTP router", () => {
  let key: TestKey;
  let server: Server;
  let baseUrl: string;
  let keysDir: string;
  let received: RouteRequest | undefined;

  beforeEach(async () => {
    key = makeTestKey();
    keysDir = mkdtempSync(join(tmpdir(), "vault-http-keys-"));
    const keysPath = join(keysDir, "authorized_keys");
    writeFileSync(keysPath, `${key.authorizedKeysLine}\n`, "utf8");
    const keyStore = new KeyStore(keysPath);
    server = createVaultHttpServer({
      keyStore,
      bodyLimitBytes: 1024,
      handlers: {
        health: () => jsonResponse({ status: "ok" }),
        contentDetail: (request) => jsonResponse({ id: request.params.content_id }),
        contentAnnotationsCreate: (request) => {
          received = request;
          return jsonResponse({ id: request.params.content_id });
        },
        search: (request) => {
          received = request;
          return jsonResponse({ query: request.body.toString("utf8") });
        },
        contentDownload: () => rawResponse(Buffer.from([0, 1, 2, 255])),
      },
    });
    baseUrl = `http://127.0.0.1:${await listen(server)}`;
  });

  afterEach(async () => {
    await close(server);
    rmSync(keysDir, { recursive: true, force: true });
  });

  it("allows unauthenticated health checks", async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("verifies signed requests and passes params, last-wins query values, and raw body", async () => {
    const path = "/api/v1/content/example/annotations?tag=first&tag=last";
    const body = Buffer.from('{"text":"note"}', "utf8");
    const host = new URL(baseUrl).host;
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: signRequest(key, "POST", path, host, body),
      body,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ id: "example" });
    expect(received).toEqual({
      params: { content_id: "example" },
      query: { tag: "last" },
      body,
      keyId: key.keyId,
    });
  });

  it("rejects unsigned protected routes", async () => {
    const response = await fetch(`${baseUrl}/api/v1/content/example`);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ detail: "Missing signature headers" });
  });

  it("rejects a body changed after it was signed", async () => {
    const path = "/api/v1/search";
    const originalBody = Buffer.from('{"query":"trusted"}', "utf8");
    const tamperedBody = '{"query":"tampered"}';
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...signRequest(key, "POST", path, new URL(baseUrl).host, originalBody),
        "content-type": "application/json",
      },
      body: tamperedBody,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ detail: "Invalid signature" });
  });

  it("returns FastAPI-compatible JSON for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/api/v1/not-a-route`);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ detail: "Not Found" });
  });

  it("rejects oversized bodies before signature verification", async () => {
    const limitedServer = createVaultHttpServer({
      keyStore: new KeyStore(join(keysDir, "authorized_keys")),
      bodyLimitBytes: 4,
      handlers: { search: () => jsonResponse({ ok: true }) },
    });
    const port = await listen(limitedServer);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/search`, {
        method: "POST",
        body: "oversized",
      });

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ detail: "Request body too large" });
    } finally {
      await close(limitedServer);
    }
  });

  it("returns raw bytes from the content download route", async () => {
    const path = "/api/v1/content/example/download";
    const response = await fetch(`${baseUrl}${path}`, {
      headers: signRequest(key, "GET", path, new URL(baseUrl).host),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from([0, 1, 2, 255]));
  });
});
