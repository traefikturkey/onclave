import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import { HttpError } from "./errors";
import type { KeyStore } from "./keys";
import { verifySignedRequest } from "./signature";

const DEFAULT_BODY_LIMIT_BYTES = 10 * 1024 * 1024;

type RouteDefinition = {
  name: string;
  method: string;
  path: string;
  public: boolean;
};

/** The complete keep and keep-thin Menos vault route inventory. */
export const VAULT_ROUTE_TABLE = [
  { name: "health", method: "GET", path: "/health", public: true },
  { name: "ready", method: "GET", path: "/ready", public: true },
  { name: "authKeys", method: "GET", path: "/api/v1/auth/keys", public: false },
  { name: "authKeysReload", method: "POST", path: "/api/v1/auth/keys/reload", public: false },
  { name: "authWhoami", method: "GET", path: "/api/v1/auth/whoami", public: false },
  { name: "agentsRpc", method: "POST", path: "/api/v1/agents/rpc", public: false },
  { name: "agentsMessages", method: "POST", path: "/api/v1/agents/messages", public: false },
  {
    name: "agentsMessagesNext",
    method: "GET",
    path: "/api/v1/agents/messages/next",
    public: false,
  },
  {
    name: "agentsMessageDisposition",
    method: "POST",
    path: "/api/v1/agents/messages/{delivery_id}",
    public: false,
  },
  { name: "contentList", method: "GET", path: "/api/v1/content", public: false },
  { name: "contentStats", method: "GET", path: "/api/v1/content/stats", public: false },
  { name: "contentTags", method: "GET", path: "/api/v1/content/tags", public: false },
  {
    name: "contentDetail",
    method: "GET",
    path: "/api/v1/content/{content_id}",
    public: false,
  },
  {
    name: "contentUpdate",
    method: "PATCH",
    path: "/api/v1/content/{content_id}",
    public: false,
  },
  {
    name: "contentDelete",
    method: "DELETE",
    path: "/api/v1/content/{content_id}",
    public: false,
  },
  {
    name: "contentAnnotationsList",
    method: "GET",
    path: "/api/v1/content/{content_id}/annotations",
    public: false,
  },
  {
    name: "contentAnnotationsCreate",
    method: "POST",
    path: "/api/v1/content/{content_id}/annotations",
    public: false,
  },
  {
    name: "contentChunks",
    method: "GET",
    path: "/api/v1/content/{content_id}/chunks",
    public: false,
  },
  {
    name: "contentDownload",
    method: "GET",
    path: "/api/v1/content/{content_id}/download",
    public: false,
  },
  {
    name: "contentReprocess",
    method: "POST",
    path: "/api/v1/content/{content_id}/reprocess",
    public: false,
  },
  {
    name: "contentEmbeddingsReindex",
    method: "POST",
    path: "/api/v1/content/{content_id}/reindex-embeddings",
    public: false,
  },
  { name: "ingest", method: "POST", path: "/api/v1/ingest", public: false },
  { name: "jobsList", method: "GET", path: "/api/v1/jobs", public: false },
  { name: "jobsStats", method: "GET", path: "/api/v1/jobs/stats", public: false },
  { name: "jobDetail", method: "GET", path: "/api/v1/jobs/{job_id}", public: false },
  {
    name: "jobCancel",
    method: "POST",
    path: "/api/v1/jobs/{job_id}/cancel",
    public: false,
  },
  { name: "search", method: "POST", path: "/api/v1/search", public: false },
  { name: "usage", method: "GET", path: "/api/v1/usage", public: false },
  { name: "youtubeChannel", method: "GET", path: "/api/v1/youtube/channel", public: false },
] as const satisfies readonly RouteDefinition[];

export type VaultRouteName = (typeof VAULT_ROUTE_TABLE)[number]["name"];

export type RouteRequest = {
  params: Record<string, string>;
  query: Record<string, string>;
  body: Buffer;
  keyId: string | undefined;
};

export type JsonRouteResponse = {
  json: unknown;
  status?: number;
  headers?: Record<string, string>;
};

export type RawRouteResponse = {
  raw: string | Buffer;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
};

export type RouteResponse = JsonRouteResponse | RawRouteResponse;

export type RouteHandler = (request: RouteRequest) => RouteResponse | Promise<RouteResponse>;

export type VaultHandlers = Partial<Record<VaultRouteName, RouteHandler>>;

export type VaultHttpOptions = {
  keyStore: KeyStore;
  handlers: VaultHandlers;
  bodyLimitBytes?: number;
};

export function jsonResponse(
  json: unknown,
  status = 200,
  headers?: Record<string, string>,
): JsonRouteResponse {
  return { json, status, headers };
}

export function rawResponse(
  raw: string | Buffer,
  contentType?: string,
  status = 200,
  headers?: Record<string, string>,
): RawRouteResponse {
  return { raw, contentType, status, headers };
}

function readRawBody(request: IncomingMessage, bodyLimitBytes: number): Promise<Buffer> {
  const contentLength = request.headers["content-length"];
  if (contentLength !== undefined && Number.parseInt(contentLength, 10) > bodyLimitBytes) {
    request.resume();
    return Promise.reject(new HttpError(413, "Request body too large"));
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;

    const fail = (error: Error): void => {
      if (finished) return;
      finished = true;
      reject(error);
    };

    request.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > bodyLimitBytes) {
        request.resume();
        fail(new HttpError(413, "Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (finished) return;
      finished = true;
      resolve(Buffer.concat(chunks));
    });
    request.on("error", (error: Error) => fail(error));
  });
}

function findRoute(method: string, path: string): { route: RouteDefinition; params: Record<string, string> } | undefined {
  const pathSegments = path.split("/");
  for (const route of VAULT_ROUTE_TABLE) {
    if (route.method !== method) continue;
    const routeSegments = route.path.split("/");
    if (routeSegments.length !== pathSegments.length) continue;

    const params: Record<string, string> = {};
    let matches = true;
    for (let index = 0; index < routeSegments.length; index += 1) {
      const routeSegment = routeSegments[index];
      const pathSegment = pathSegments[index];
      if (routeSegment === undefined || pathSegment === undefined) {
        matches = false;
        break;
      }
      const paramMatch = /^\{([a-z_]+)\}$/.exec(routeSegment);
      if (paramMatch !== null) {
        const paramName = paramMatch[1];
        if (paramName !== undefined) params[paramName] = decodePathSegment(pathSegment);
      } else if (routeSegment !== pathSegment) {
        matches = false;
        break;
      }
    }
    if (matches) return { route, params };
  }
  return undefined;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseQuery(searchParams: URLSearchParams): Record<string, string> {
  const query: Record<string, string> = {};
  for (const [key, value] of searchParams) query[key] = value;
  return query;
}

function normalizeHeaders(headers: IncomingHttpHeaders): Record<string, string | undefined> {
  const normalized: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    normalized[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return normalized;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  const serialized = JSON.stringify(body);
  response.end(`${serialized ?? "null"}\n`);
}

function writeResponse(response: ServerResponse, result: RouteResponse): void {
  const status = result.status ?? 200;
  if ("json" in result) {
    response.writeHead(status, { "content-type": "application/json", ...result.headers });
    const serialized = JSON.stringify(result.json);
    response.end(`${serialized ?? "null"}\n`);
    return;
  }

  const contentType =
    result.contentType ?? (typeof result.raw === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
  response.writeHead(status, { "content-type": contentType, ...result.headers });
  response.end(result.raw);
}

function isHttpError(error: unknown): error is HttpError {
  return error instanceof HttpError;
}

/** Creates a dependency-free node:http request handler for the vault API. */
export function createVaultHttpHandler(options: VaultHttpOptions): (request: IncomingMessage, response: ServerResponse) => void {
  const bodyLimitBytes = options.bodyLimitBytes ?? DEFAULT_BODY_LIMIT_BYTES;
  if (!Number.isSafeInteger(bodyLimitBytes) || bodyLimitBytes < 0) {
    throw new Error("bodyLimitBytes must be a non-negative safe integer");
  }

  return (request, response) => {
    void (async () => {
      try {
        const url = new URL(request.url ?? "/", "http://vault.local");
        const match = findRoute(request.method ?? "", url.pathname);
        if (match === undefined || options.handlers[match.route.name as VaultRouteName] === undefined) {
          writeJson(response, 404, { detail: "Not Found" });
          return;
        }

        const body = await readRawBody(request, bodyLimitBytes);
        const keyId = match.route.public
          ? undefined
          : verifySignedRequest(
              {
                method: request.method ?? "",
                path: request.url ?? "/",
                headers: normalizeHeaders(request.headers),
                body,
              },
              options.keyStore,
            );
        const handler = options.handlers[match.route.name as VaultRouteName];
        if (handler === undefined) {
          writeJson(response, 404, { detail: "Not Found" });
          return;
        }
        writeResponse(
          response,
          await handler({ params: match.params, query: parseQuery(url.searchParams), body, keyId }),
        );
      } catch (error) {
        if (response.writableEnded) return;
        if (isHttpError(error)) {
          writeJson(response, error.status, { detail: error.detail });
          return;
        }
        writeJson(response, 500, { detail: "Internal Server Error" });
      }
    })();
  };
}

/** Creates an unbound node:http server for the vault API. */
export function createVaultHttpServer(options: VaultHttpOptions): Server {
  return createServer(createVaultHttpHandler(options));
}
