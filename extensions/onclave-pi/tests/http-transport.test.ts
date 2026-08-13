import { createPrivateKey, createPublicKey, randomBytes, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEnvelope, parseEnvelope, type Envelope } from "@onclave/envelope";
import { OnclaveHttpClient } from "../src/lib/http-client";
import { createRequestSignerFromOpenSsh, type RequestSigner } from "../src/lib/http-signer";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PUBLIC_KEY_OFFSET = 12;
const OPENSSH_PEM_LABEL = ["OPENSSH", "PRIVATE", "KEY"].join(" ");
const SSH_ED25519 = "ssh-ed25519";

type TestKey = {
  privateKey: KeyObject;
  signer: RequestSigner;
};

type LeasedDelivery = {
  agentId: string;
  keyId: string;
  envelope: Envelope;
};

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value, 0);
  return bytes;
}

function sshString(value: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, "utf8");
  return Buffer.concat([uint32(bytes.length), bytes]);
}

function openSshPrivateKey(seed: Buffer, publicKey: Buffer): Buffer {
  const publicBlob = Buffer.concat([sshString(SSH_ED25519), sshString(publicKey)]);
  let privateBlob = Buffer.concat([
    uint32(1),
    uint32(1),
    sshString(SSH_ED25519),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString("transport-test"),
  ]);
  const paddingLength = (8 - (privateBlob.length % 8)) % 8;
  if (paddingLength > 0) {
    privateBlob = Buffer.concat([privateBlob, Buffer.from(Array.from({ length: paddingLength }, (_, index) => index + 1))]);
  }
  const payload = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "utf8"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(publicBlob),
    sshString(privateBlob),
  ]);
  return Buffer.from(
    `-----BEGIN ${OPENSSH_PEM_LABEL}-----\n${payload.toString("base64")}\n-----END ${OPENSSH_PEM_LABEL}-----\n`,
    "utf8"
  );
}

function testKey(): TestKey {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PUBLIC_KEY_OFFSET);
  return { privateKey, signer: createRequestSignerFromOpenSsh(openSshPrivateKey(seed, publicKey)) };
}

function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function verifiedKeyId(
  request: IncomingMessage,
  path: string,
  body: Buffer,
  keys: Map<string, KeyObject>
): string | undefined {
  const signatureInput = request.headers["signature-input"];
  const signatureHeader = request.headers.signature;
  if (typeof signatureInput !== "string" || typeof signatureHeader !== "string") return undefined;
  const keyId = /keyid="([^"]+)"/.exec(signatureInput)?.[1];
  if (keyId === undefined) return undefined;
  const privateKey = keys.get(keyId);
  if (privateKey === undefined) return undefined;
  const params = signatureInput.slice("sig1=".length);
  const host = request.headers.host ?? "";
  const lines = [`"@method": ${request.method ?? ""}`, `"@path": ${path}`, `"@authority": ${host}`];
  if (body.length > 0) {
    const digest = request.headers["content-digest"];
    if (typeof digest !== "string") return undefined;
    lines.push(`"content-digest": ${digest}`);
  }
  lines.push(`"@signature-params": ${params}`);
  const signature = /^sig1=:([A-Za-z0-9+/=]+):$/.exec(signatureHeader)?.[1];
  if (signature === undefined) return undefined;
  return cryptoVerify(null, Buffer.from(lines.join("\n"), "utf8"), privateKey, Buffer.from(signature, "base64"))
    ? keyId
    : undefined;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("signed HTTP two-adapter transport", () => {
  let server: Server;
  let baseUrl: string;
  let clientA: OnclaveHttpClient;
  let clientB: OnclaveHttpClient;
  const cards = new Map<string, string>();
  const queues = new Map<string, Envelope[]>();
  const deliveries = new Map<string, LeasedDelivery>();
  const dispositions: Array<{ deliveryId: string; disposition: string }> = [];
  let deliveryNumber = 0;
  let authenticatedRequests = 0;

  beforeEach(async () => {
    cards.clear();
    queues.clear();
    deliveries.clear();
    dispositions.length = 0;
    deliveryNumber = 0;
    authenticatedRequests = 0;
    const keyA = testKey();
    const keyB = testKey();
    const keys = new Map([
      [keyA.signer.keyId, keyA.privateKey],
      [keyB.signer.keyId, keyB.privateKey],
    ]);
    server = createServer((request, response) => {
      void (async () => {
        const path = request.url ?? "/";
        const body = await requestBody(request);
        const keyId = verifiedKeyId(request, path, body, keys);
        if (keyId === undefined) {
          writeJson(response, 401, { detail: "Invalid signature" });
          return;
        }
        authenticatedRequests += 1;
        const url = new URL(path, "http://transport.test");
        if (request.method === "POST" && url.pathname === "/api/v1/agents/rpc") {
          const rpc = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
          if (rpc.op === "register" && rpc.card !== null && typeof rpc.card === "object") {
            const card = rpc.card as Record<string, unknown>;
            if (typeof card.agent_id !== "string") {
              writeJson(response, 422, { detail: "Invalid card" });
              return;
            }
            cards.set(card.agent_id, keyId);
            writeJson(response, 200, { ok: true });
            return;
          }
          if (rpc.op === "list_agents") {
            writeJson(response, 200, { ok: true, agents: [...cards.keys()].map((agent_id) => ({ agent_id, alive: true })) });
            return;
          }
          writeJson(response, 200, { ok: true });
          return;
        }
        if (request.method === "POST" && url.pathname === "/api/v1/agents/messages") {
          const parsed = parseEnvelope(JSON.parse(body.toString("utf8")) as unknown);
          if (!parsed.ok) {
            writeJson(response, 422, { detail: parsed.error });
            return;
          }
          const messages = queues.get(parsed.envelope.to) ?? [];
          messages.push(parsed.envelope);
          queues.set(parsed.envelope.to, messages);
          writeJson(response, 202, { ok: true, message_id: parsed.envelope.id });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/v1/agents/messages/next") {
          const agentId = url.searchParams.get("agent_id");
          if (agentId === null || cards.get(agentId) !== keyId) {
            writeJson(response, 403, { detail: "Wrong agent key" });
            return;
          }
          const envelope = queues.get(agentId)?.shift();
          if (envelope === undefined) {
            response.writeHead(204);
            response.end();
            return;
          }
          deliveryNumber += 1;
          const deliveryId = `delivery-${deliveryNumber}`;
          deliveries.set(deliveryId, { agentId, keyId, envelope });
          writeJson(response, 200, { delivery_id: deliveryId, envelope });
          return;
        }
        const dispositionMatch = /^\/api\/v1\/agents\/messages\/([^/]+)$/.exec(url.pathname);
        if (request.method === "POST" && dispositionMatch !== null) {
          const deliveryId = decodeURIComponent(dispositionMatch[1] ?? "");
          const delivery = deliveries.get(deliveryId);
          const disposition = (JSON.parse(body.toString("utf8")) as Record<string, unknown>).disposition;
          if (delivery === undefined || delivery.keyId !== keyId || (disposition !== "ack" && disposition !== "reject")) {
            writeJson(response, 403, { detail: "Invalid disposition" });
            return;
          }
          deliveries.delete(deliveryId);
          dispositions.push({ deliveryId, disposition });
          writeJson(response, 200, { ok: true });
          return;
        }
        writeJson(response, 404, { detail: "Not found" });
      })().catch(() => writeJson(response, 500, { detail: "Test server error" }));
    });
    baseUrl = await listen(server);
    clientA = new OnclaveHttpClient({ apiBase: baseUrl, signer: keyA.signer });
    clientB = new OnclaveHttpClient({ apiBase: baseUrl, signer: keyB.signer });
  });

  afterEach(async () => {
    await close(server);
  });

  it("registers, publishes direct informs and correlated replies, long-polls, and acknowledges through signed HTTP", async () => {
    await clientA.call({
      op: "register",
      protocol_version: 1,
      card: { agent_id: "agent-a", name: "A", host: "host-a", transport: "https" },
    });
    await clientB.call({
      op: "register",
      protocol_version: 1,
      card: { agent_id: "agent-b", name: "B", host: "host-b", transport: "https" },
    });
    const request = createEnvelope({
      performative: "request",
      from: { agent_id: "agent-a", name: "A", host: "host-a" },
      to: "agent-b",
      body: "status?",
    });
    await clientA.publish(request);
    const receivedRequest = await clientB.next("agent-b", 0);
    expect(receivedRequest?.envelope).toEqual(request);
    await clientB.dispose(receivedRequest?.deliveryId ?? "", "ack");

    const reply = createEnvelope({
      performative: "inform",
      from: { agent_id: "agent-b", name: "B", host: "host-b" },
      to: "agent-a",
      body: "healthy",
      conversationId: request.conversation_id,
      inReplyTo: request.id,
    });
    await clientB.publish(reply);
    const receivedReply = await clientA.next("agent-a", 0);
    expect(receivedReply?.envelope).toEqual(reply);
    await clientA.dispose(receivedReply?.deliveryId ?? "", "ack");

    const directInform = createEnvelope({
      performative: "inform",
      from: { agent_id: "agent-a", name: "A", host: "host-a" },
      to: "agent-b",
      body: "maintenance starts at midnight",
    });
    await clientA.publish(directInform);
    const receivedInform = await clientB.next("agent-b", 0);
    expect(receivedInform?.envelope).toEqual(directInform);
    await clientB.dispose(receivedInform?.deliveryId ?? "", "ack");

    expect(authenticatedRequests).toBe(11);
    expect(dispositions).toEqual([
      { deliveryId: "delivery-1", disposition: "ack" },
      { deliveryId: "delivery-2", disposition: "ack" },
      { deliveryId: "delivery-3", disposition: "ack" },
    ]);
  });
});
