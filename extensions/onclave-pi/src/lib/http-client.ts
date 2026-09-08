import { parseMessage, type Message, type TaskStatusEvent } from "@onclave/envelope";
import type { RequestSigner } from "./http-signer";

const API_ROOT_PATH = "/api/v1/";
const AGENTS_PATH = "agents";
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
export type OnclaveHttpClientOptions = { apiBase: string; signer: RequestSigner; fetchFn?: FetchFn; signal?: AbortSignal };
export type Delivery = { deliveryId: string; kind: "message" | "task-status"; message?: Message; status?: TaskStatusEvent };
type JsonRecord = Record<string, unknown>;
function record(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function normalizeApiBase(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error("ONCLAVE_API_BASE must be a valid http or https URL"); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") throw new Error("ONCLAVE_API_BASE must be an origin or end in /api/v1");
  if (parsed.pathname === "/" || parsed.pathname === "/api/v1" || parsed.pathname === "/api/v1/") parsed.pathname = API_ROOT_PATH; else throw new Error("ONCLAVE_API_BASE must be an origin or end in /api/v1");
  return parsed;
}
function errorFor(status: number, body: string): Error {
  let detail: string | undefined;
  try { const parsed: unknown = JSON.parse(body); if (record(parsed) && typeof parsed.detail === "string") detail = parsed.detail; } catch { /* public error only */ }
  return new Error(`Onclave API request failed (${status})${detail === undefined ? "" : `: ${detail}`}`);
}
export class OnclaveHttpClient {
  private readonly apiBase: URL;
  private readonly fetchFn: FetchFn;
  constructor(private readonly options: OnclaveHttpClientOptions) { this.apiBase = normalizeApiBase(options.apiBase); this.fetchFn = options.fetchFn ?? fetch; }
  async call(request: object, signal?: AbortSignal): Promise<JsonRecord> { return this.json("POST", `${AGENTS_PATH}/rpc`, request, signal); }
  async publish(message: Message, signal?: AbortSignal): Promise<void> {
    const response = await this.request("POST", `${AGENTS_PATH}/messages`, message, signal);
    if (response.status !== 202) throw errorFor(response.status, await response.text());
    const body: unknown = await response.json();
    if (!record(body) || body.ok !== true || body.message_id !== message.message_id) throw new Error("Onclave API returned an invalid publish response");
  }
  async next(instanceId: string, waitMs: number, signal?: AbortSignal): Promise<Delivery | undefined> {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) throw new Error("Onclave delivery wait must be a non-negative safe integer");
    const query = new URLSearchParams({ agent_id: instanceId, wait_ms: String(waitMs) });
    const response = await this.request("GET", `${AGENTS_PATH}/messages/next?${query}`, undefined, signal);
    if (response.status === 204) return undefined;
    if (!response.ok) throw errorFor(response.status, await response.text());
    const payload: unknown = await response.json();
    if (!record(payload) || typeof payload.delivery_id !== "string" || (payload.kind !== "message" && payload.kind !== "task-status")) throw new Error("Onclave API returned an invalid delivery");
    if (payload.kind === "message") { const parsed = parseMessage(payload.message); if (!parsed.ok) throw new Error(`invalid message: ${parsed.error}`); return { deliveryId: payload.delivery_id, kind: "message", message: parsed.value }; }
    if (!record(payload.status)) throw new Error("Onclave API returned an invalid task status");
    return { deliveryId: payload.delivery_id, kind: "task-status", status: payload.status as TaskStatusEvent };
  }
  async dispose(deliveryId: string, disposition: "ack" | "reject", signal?: AbortSignal): Promise<void> {
    const response = await this.json("POST", `${AGENTS_PATH}/messages/${encodeURIComponent(deliveryId)}`, { disposition }, signal);
    if (response.ok !== true) throw new Error("Onclave API returned an invalid disposition response");
  }
  private async json(method: string, path: string, body: object, signal?: AbortSignal): Promise<JsonRecord> {
    const response = await this.request(method, path, body, signal);
    if (!response.ok) throw errorFor(response.status, await response.text());
    const parsed: unknown = await response.json(); if (!record(parsed)) throw new Error("Onclave API returned an invalid JSON response"); return parsed;
  }
  private async request(method: string, path: string, body: object | undefined, signal?: AbortSignal): Promise<Response> {
    signal = signal && this.options.signal ? AbortSignal.any([signal, this.options.signal]) : signal ?? this.options.signal;
    signal?.throwIfAborted();
    const url = new URL(path, this.apiBase);
    const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const headers = this.options.signer.signRequest(method, `${url.pathname}${url.search}`, url.host, bytes);
    return this.fetchFn(url.toString(), { method, headers: { ...(bytes === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(bytes === undefined ? {} : { body: bytes }), ...(signal === undefined ? {} : { signal }) });
  }
}
export function resolveApiBase(explicitUrl: string | undefined, environment: NodeJS.ProcessEnv = process.env): string {
  const value = explicitUrl ?? environment.ONCLAVE_API_BASE;
  if (value === undefined || value.trim() === "") throw new Error("ONCLAVE_API_BASE is required");
  const result = normalizeApiBase(value.trim()); if (result.protocol !== "https:") throw new Error("ONCLAVE_API_BASE must use https"); return result.toString();
}
