import { parseEnvelope, type Envelope } from "@onclave/envelope";
import type { RequestSigner } from "./http-signer";

const API_ROOT_PATH = "/api/v1/";
const AGENTS_PATH = "agents";

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export type OnclaveHttpClientOptions = {
  apiBase: string;
  signer: RequestSigner;
  fetchFn?: FetchFn;
};

export type Delivery = {
  deliveryId: string;
  envelope: Envelope;
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeApiBase(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("ONCLAVE_API_BASE must be a valid http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("ONCLAVE_API_BASE must use http or https");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("ONCLAVE_API_BASE must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("ONCLAVE_API_BASE must not contain a query or fragment");
  }
  if (parsed.pathname === "/") {
    parsed.pathname = API_ROOT_PATH;
  } else if (parsed.pathname === API_ROOT_PATH.slice(0, -1) || parsed.pathname === API_ROOT_PATH) {
    parsed.pathname = API_ROOT_PATH;
  } else {
    throw new Error("ONCLAVE_API_BASE must be an origin or end in /api/v1");
  }
  return parsed;
}

function responseError(status: number, body: string): Error {
  let detail: string | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.detail === "string") detail = parsed.detail;
  } catch {
    // Error messages use only a server-provided public detail when available.
  }
  return new Error(`Onclave API request failed (${status})${detail === undefined ? "" : `: ${detail}`}`);
}

function asRecord(value: unknown, context: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`Onclave API returned an invalid ${context} response`);
  return value;
}

export class OnclaveHttpClient {
  private readonly apiBase: URL;
  private readonly fetchFn: FetchFn;

  constructor(private readonly options: OnclaveHttpClientOptions) {
    this.apiBase = normalizeApiBase(options.apiBase);
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async call(request: object, signal?: AbortSignal): Promise<JsonRecord> {
    return this.requestJson("POST", `${AGENTS_PATH}/rpc`, request, signal);
  }

  async publish(envelope: Envelope, signal?: AbortSignal): Promise<void> {
    const response = await this.requestJson("POST", `${AGENTS_PATH}/messages`, envelope, signal, [202]);
    if (response.ok !== true || response.message_id !== envelope.id) {
      throw new Error("Onclave API returned an invalid message publish response");
    }
  }

  async next(agentId: string, waitMs: number, signal?: AbortSignal): Promise<Delivery | undefined> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      throw new Error("Onclave long-poll wait must be a non-negative safe integer");
    }
    const query = new URLSearchParams({ agent_id: agentId, wait_ms: String(waitMs) });
    const response = await this.request("GET", `${AGENTS_PATH}/messages/next?${query.toString()}`, undefined, signal);
    if (response.status === 204) return undefined;
    if (!response.ok) throw responseError(response.status, await response.text());
    const payload = asRecord(await response.json(), "delivery");
    if (typeof payload.delivery_id !== "string" || payload.delivery_id === "") {
      throw new Error("Onclave API returned a delivery without a delivery_id");
    }
    const parsed = parseEnvelope(payload.envelope);
    if (!parsed.ok) throw new Error(`Onclave API returned an invalid envelope: ${parsed.error}`);
    return { deliveryId: payload.delivery_id, envelope: parsed.envelope };
  }

  async dispose(deliveryId: string, disposition: "ack" | "reject", signal?: AbortSignal): Promise<void> {
    const response = await this.requestJson(
      "POST",
      `${AGENTS_PATH}/messages/${encodeURIComponent(deliveryId)}`,
      { disposition },
      signal
    );
    if (response.ok !== true) throw new Error("Onclave API returned an invalid delivery disposition response");
  }

  private async requestJson(
    method: string,
    path: string,
    body: object,
    signal?: AbortSignal,
    successStatuses: readonly number[] = [200]
  ): Promise<JsonRecord> {
    const response = await this.request(method, path, body, signal);
    if (!successStatuses.includes(response.status)) {
      throw responseError(response.status, await response.text());
    }
    return asRecord(await response.json(), "JSON");
  }

  private async request(
    method: string,
    path: string,
    body: object | undefined,
    signal?: AbortSignal
  ): Promise<Response> {
    const url = new URL(path, this.apiBase);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const signedPath = `${url.pathname}${url.search}`;
    const signatureHeaders = this.options.signer.signRequest(method, signedPath, url.host, bytes);
    return this.fetchFn(url.toString(), {
      method,
      headers: {
        ...(bytes === undefined ? {} : { "content-type": "application/json" }),
        ...signatureHeaders,
      },
      ...(bytes === undefined ? {} : { body: bytes }),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}

export function resolveApiBase(explicitUrl: string | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  const value = explicitUrl ?? environment.ONCLAVE_API_BASE;
  if (value === undefined || value.trim() === "") {
    throw new Error("ONCLAVE_API_BASE is required");
  }
  const apiBase = normalizeApiBase(value.trim());
  if (apiBase.protocol !== "https:") {
    throw new Error("ONCLAVE_API_BASE must use https");
  }
  return apiBase.toString();
}
