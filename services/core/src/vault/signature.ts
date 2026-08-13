import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { HttpError } from "./errors";
import type { KeyStore } from "./keys";

/** DER prefix that wraps a raw ed25519 public key into SPKI format. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Signature validity window in seconds. */
const MAX_AGE_SECONDS = 300;

/**
 * Request shape consumed by signature verification, decoupled from the HTTP
 * server implementation. `path` must include the query string when present,
 * `headers` must use lowercase names, and `body` must be the raw bytes.
 */
export type SignedRequestInput = {
  method: string;
  path: string;
  targetUri?: string;
  headers: Record<string, string | undefined>;
  body?: Buffer;
};

type SignatureParams = {
  components: string[];
  params: Record<string, string>;
  signatureParams: string;
};

const REQUIRED_COMPONENTS = ["@method", "@path", "@authority"] as const;

function parseSignatureInput(sigInput: string): SignatureParams {
  const match = /^(\w+)=\(([^)]*)\);?(.*)$/.exec(sigInput);
  if (match === null) {
    throw new HttpError(400, "Invalid signature-input format");
  }
  const componentsStr = match[2] ?? "";
  const paramsStr = match[3] ?? "";
  const components: string[] = [];
  for (const component of componentsStr.matchAll(/"([^"]+)"/g)) {
    if (component[1] !== undefined) components.push(component[1]);
  }
  const params: Record<string, string> = {};
  for (const param of paramsStr.matchAll(/(\w+)=(?:"([^"]+)"|(\d+))/g)) {
    const key = param[1];
    const value = param[2] ?? param[3];
    if (key !== undefined && value !== undefined) params[key] = value;
  }
  const separatorIndex = sigInput.indexOf("=");
  const signatureParams = separatorIndex >= 0 ? sigInput.slice(separatorIndex + 1) : sigInput;
  return { components, params, signatureParams };
}

function validateParams(params: Record<string, string>): string {
  const keyId = params.keyid;
  if (keyId === undefined || keyId === "") {
    throw new HttpError(401, "Missing keyid in signature-input");
  }
  const alg = params.alg ?? "ed25519";
  if (alg !== "ed25519") {
    throw new HttpError(401, `Unsupported algorithm: ${alg}`);
  }
  return keyId;
}

function checkTimestamp(created: string | undefined): void {
  if (created === undefined) {
    throw new HttpError(401, "Missing created in signature-input");
  }
  if (!/^\d+$/.test(created)) {
    throw new HttpError(401, "Invalid created in signature-input");
  }
  const createdSeconds = Number(created);
  const ageSeconds = Date.now() / 1000 - createdSeconds;
  if (!Number.isSafeInteger(createdSeconds) || !Number.isFinite(ageSeconds) || Math.abs(ageSeconds) > MAX_AGE_SECONDS) {
    throw new HttpError(401, "Signature expired or from future");
  }
}

function contentDigest(body: Buffer | undefined): string {
  const digest = createHash("sha256").update(body ?? Buffer.alloc(0)).digest("base64");
  return `sha-256=:${digest}:`;
}

function validateComponentProfile(request: SignedRequestInput, components: string[]): void {
  const bodyIsNonempty = (request.body?.length ?? 0) > 0;
  const requiredComponents = bodyIsNonempty
    ? [...REQUIRED_COMPONENTS, "content-digest"]
    : REQUIRED_COMPONENTS;
  if (
    components.length !== requiredComponents.length
    || components.some((component, index) => component !== requiredComponents[index])
  ) {
    throw new HttpError(401, "Invalid signature component profile");
  }

  const suppliedDigest = request.headers["content-digest"];
  if (bodyIsNonempty && suppliedDigest === undefined) {
    throw new HttpError(401, "Missing content-digest header");
  }
  if (suppliedDigest !== undefined && suppliedDigest !== contentDigest(request.body)) {
    throw new HttpError(401, "Invalid content-digest header");
  }
}

function resolveComponent(request: SignedRequestInput, component: string): string {
  if (component === "@method") {
    return `"@method": ${request.method}`;
  }
  if (component === "@path") {
    return `"@path": ${request.path}`;
  }
  if (component === "@authority") {
    return `"@authority": ${request.headers.host ?? ""}`;
  }
  if (component === "@target-uri") {
    return `"@target-uri": ${request.targetUri ?? ""}`;
  }
  if (component === "content-digest") {
    return `"content-digest": ${request.headers["content-digest"] ?? ""}`;
  }
  return `"${component}": ${request.headers[component] ?? ""}`;
}

function buildSignatureBase(
  request: SignedRequestInput,
  components: string[],
  signatureParams: string,
): string {
  const lines = components.map((component) => resolveComponent(request, component));
  lines.push(`"@signature-params": ${signatureParams}`);
  return lines.join("\n");
}

function extractSignature(signatureHeader: string): Buffer {
  const match = /^\w+=:([A-Za-z0-9+/=]+):/.exec(signatureHeader);
  if (match === null || match[1] === undefined) {
    throw new HttpError(400, "Invalid signature format");
  }
  return Buffer.from(match[1], "base64");
}

/**
 * Verifies an RFC 9421 HTTP message signature and returns the authenticated
 * key id. Semantics mirror the Python Menos verifier so signatures produced
 * by the unmodified dotfiles client signer keep verifying.
 */
export function verifySignedRequest(request: SignedRequestInput, keyStore: KeyStore): string {
  const sigInput = request.headers["signature-input"];
  const signature = request.headers.signature;
  if (sigInput === undefined || sigInput === "" || signature === undefined || signature === "") {
    throw new HttpError(401, "Missing signature headers");
  }

  const parsed = parseSignatureInput(sigInput);
  const keyId = validateParams(parsed.params);
  checkTimestamp(parsed.params.created);
  validateComponentProfile(request, parsed.components);

  const publicKeyRaw = keyStore.getKey(keyId);
  if (publicKeyRaw === undefined) {
    throw new HttpError(401, `Unknown key: ${keyId}`);
  }

  const signatureBase = buildSignatureBase(request, parsed.components, parsed.signatureParams);
  const signatureBytes = extractSignature(signature);
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyRaw]),
    format: "der",
    type: "spki",
  });

  const valid = cryptoVerify(null, Buffer.from(signatureBase, "utf8"), publicKey, signatureBytes);
  if (!valid) {
    throw new HttpError(401, "Invalid signature");
  }
  return keyId;
}
