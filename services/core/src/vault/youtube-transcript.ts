import { ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

export type TranscriptSegment = {
  text: string;
  start: number;
  duration: number;
};

export type YouTubeTranscript = {
  videoId: string;
  segments: TranscriptSegment[];
  language: string;
  fullText: string;
  timestampedText: string;
};

export type WebshareProxyCredentials = {
  username: string;
  password: string;
};

export type TranscriptFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  dispatcher?: Dispatcher;
  signal?: AbortSignal;
};

export type TranscriptFetchResponse = {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type TranscriptFetcher = (url: string, init?: TranscriptFetchInit) => Promise<TranscriptFetchResponse>;

type CaptionTrack = {
  baseUrl: string;
  languageCode: string;
  kind?: string;
};

type PlayerResponse = {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
    };
  };
  playabilityStatus?: {
    status?: string;
    reason?: string;
  };
};

const YOUTUBE_WATCH_URL = "https://www.youtube.com/watch?v=";
const YOUTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?key=";
const YOUTUBE_CLIENT_NAME = "ANDROID";
const YOUTUBE_CLIENT_VERSION = "20.10.38";
const WEBSHARE_PROXY_HOST = "p.webshare.io:80";
const TRANSCRIPT_UNAVAILABLE_PREFIX = "YouTube is blocking requests for video";
export const YOUTUBE_TRANSCRIPT_OVERALL_TIMEOUT_MS = 25_000;

export type TranscriptStage = "watch" | "player" | "captions" | "request";
export type TranscriptFailureClassification = "network" | "timeout" | "rate_limited" | "upstream" | "blocked";

export type TranscriptAttemptEvent = Readonly<{
  stage: TranscriptStage;
  attempt: number;
  outcome: "success" | "retry" | "failure";
  classification?: TranscriptFailureClassification;
  durationMs: number;
  httpStatus?: number;
}>;

export type TranscriptProxyDiagnostic = Readonly<{
  mode: "webshare" | "custom" | "direct";
  configured: boolean;
  credentialStatus: "present" | "missing" | "not_applicable";
  dispatcherStatus: "owned" | "injected" | "none";
  connectivity: "not_checked";
}>;

export type TranscriptFailureDiagnostic = {
  stage: TranscriptStage;
  classification: TranscriptFailureClassification;
  attempts: number;
  httpStatus?: number;
  errorName?: string;
  errorCode?: string;
  errno?: number | string;
  syscall?: string;
};

export class TranscriptUpstreamUnavailable extends Error {
  readonly diagnostic?: TranscriptFailureDiagnostic;

  constructor(message: string, diagnostic?: TranscriptFailureDiagnostic) {
    super(message);
    this.name = "TranscriptUpstreamUnavailable";
    this.diagnostic = diagnostic;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readCaptionTracks(value: unknown): CaptionTrack[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tracks: CaptionTrack[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const baseUrl = readString(item.baseUrl);
    const languageCode = readString(item.languageCode);
    if (baseUrl === undefined || languageCode === undefined) return undefined;
    const kind = readString(item.kind);
    tracks.push(kind === undefined ? { baseUrl, languageCode } : { baseUrl, languageCode, kind });
  }
  return tracks;
}

function parsePlayerResponse(value: unknown): PlayerResponse | undefined {
  if (!isRecord(value)) return undefined;
  const response: PlayerResponse = {};
  const captions = value.captions;
  if (captions !== undefined) {
    if (!isRecord(captions) || !isRecord(captions.playerCaptionsTracklistRenderer)) return undefined;
    const tracks = readCaptionTracks(captions.playerCaptionsTracklistRenderer.captionTracks);
    if (tracks === undefined) return undefined;
    response.captions = { playerCaptionsTracklistRenderer: { captionTracks: tracks } };
  }
  const playabilityStatus = value.playabilityStatus;
  if (isRecord(playabilityStatus)) {
    response.playabilityStatus = {
      status: readString(playabilityStatus.status),
      reason: readString(playabilityStatus.reason),
    };
  }
  if (response.playabilityStatus?.status === undefined && response.captions === undefined) return undefined;
  if (response.playabilityStatus?.status === "OK" && response.captions === undefined) return undefined;
  return response;
}

function innertubeApiKeyFromWatchPage(html: string): string | undefined {
  return /"INNERTUBE_API_KEY":\s*"([A-Za-z0-9_-]+)"/.exec(html)?.[1];
}

function parseNumber(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function decodeXml(text: string): string {
  return text.replace(/&#x([0-9a-f]+);|&#(\d+);|&quot;|&apos;|&amp;|&lt;|&gt;/gi, (entity, hex, decimal) => {
    if (hex !== undefined) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (decimal !== undefined) return String.fromCodePoint(Number.parseInt(decimal, 10));
    const named: Record<string, string> = {
      "&quot;": '"',
      "&apos;": "'",
      "&amp;": "&",
      "&lt;": "<",
      "&gt;": ">",
    };
    return named[entity.toLowerCase()] ?? entity;
  });
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match?.[1];
}

/** Parses the timed-text XML format returned by YouTube caption tracks. */
export function parseTranscriptXml(xml: string): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  for (const match of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2];
    if (body === undefined) continue;
    segments.push({
      text: decodeXml(body.replace(/<[^>]*>/g, "")),
      start: parseNumber(attribute(attributes, "start")),
      duration: parseNumber(attribute(attributes, "dur")),
    });
  }
  return segments;
}

/** Parses the json3 caption format returned by YouTube caption tracks. */
export function parseTranscriptJson3(value: unknown): TranscriptSegment[] {
  if (!isRecord(value) || !Array.isArray(value.events)) return [];
  const segments: TranscriptSegment[] = [];
  for (const event of value.events) {
    if (!isRecord(event) || !Array.isArray(event.segs)) continue;
    const text = event.segs
      .flatMap((segment) => (isRecord(segment) ? [readString(segment.utf8) ?? ""] : []))
      .join("");
    segments.push({
      text,
      start: typeof event.tStartMs === "number" ? event.tStartMs / 1000 : 0,
      duration: typeof event.dDurationMs === "number" ? event.dDurationMs / 1000 : 0,
    });
  }
  return segments;
}

export function transcriptFullText(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join(" ");
}

export function transcriptTimestampedText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((segment) => {
      const minutes = Math.floor(segment.start / 60);
      const seconds = Math.floor(segment.start % 60);
      return `[${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}] ${segment.text}`;
    })
    .join("\n");
}

/** Matches youtube-transcript-api selection: requested language order, manual before ASR. */
export function selectCaptionTrack(
  tracks: readonly CaptionTrack[],
  languages: readonly string[],
): CaptionTrack | undefined {
  for (const language of languages) {
    const manual = tracks.find((track) => track.languageCode === language && track.kind !== "asr");
    if (manual !== undefined) return manual;
    const generated = tracks.find((track) => track.languageCode === language && track.kind === "asr");
    if (generated !== undefined) return generated;
  }
  return undefined;
}

export function createWebshareProxyDispatcher(credentials: WebshareProxyCredentials): ProxyAgent {
  const username = encodeURIComponent(credentials.username);
  const password = encodeURIComponent(credentials.password);
  return new ProxyAgent(`http://${username}:${password}@${WEBSHARE_PROXY_HOST}`);
}

async function defaultFetcher(url: string, init?: TranscriptFetchInit): Promise<TranscriptFetchResponse> {
  return undiciFetch(url, init);
}

export function extractYouTubeVideoId(urlOrId: string): string {
  const urlMatch = /(?:v=|\/)([0-9A-Za-z_-]{11}).*/.exec(urlOrId);
  if (urlMatch?.[1] !== undefined) return urlMatch[1];
  if (/^[0-9A-Za-z_-]{11}$/.test(urlOrId)) return urlOrId;
  throw new Error(`Could not extract video ID from: ${urlOrId}`);
}

function blockedError(videoId: string, _detail: string): TranscriptUpstreamUnavailable {
  return new TranscriptUpstreamUnavailable(
    `${TRANSCRIPT_UNAVAILABLE_PREFIX} ${videoId} despite using Webshare proxy. ` +
      "Ensure you have purchased 'Residential' proxies (not 'Proxy Server' or 'Static Residential'). " +
      "Check WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD in .env.",
    { stage: "player", classification: "blocked", attempts: 1 },
  );
}

function transcriptUnavailableError(response: PlayerResponse | undefined, videoId: string): Error {
  const status = response?.playabilityStatus?.status;
  const reason = response?.playabilityStatus?.reason;
  if (status === "ERROR" || status === "UNPLAYABLE") return new Error(`Video unavailable: ${videoId}`);
  if (status === "LOGIN_REQUIRED" && reason !== undefined) {
    if (/\bprivate video\b/i.test(reason)) return new Error(`Video unavailable: ${videoId}`);
    return blockedError(videoId, reason);
  }
  return new Error(`Transcripts disabled for video: ${videoId}`);
}

function isTranscriptContentError(error: Error): boolean {
  return error.message.startsWith("Video unavailable: ")
    || error.message.startsWith("Transcripts disabled for video: ")
    || error.message.startsWith("No transcript found for video: ");
}

type RequestFailure = {
  classification: TranscriptFailureClassification;
  httpStatus?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  error?: unknown;
};

class TranscriptRequestFailure extends Error {
  constructor(readonly failure: RequestFailure) {
    super("Transcript upstream request failed");
  }
}

function safeErrorName(value: unknown): string | undefined {
  return typeof value === "string" && [
    "Error", "TypeError", "AbortError", "TimeoutError", "FetchError", "SocketError", "ConnectTimeoutError",
  ].includes(value) ? value : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|UND_ERR_[A-Z_]+)$/.test(value)
    ? value : undefined;
}

function safeSyscall(value: unknown): string | undefined {
  return typeof value === "string" && ["connect", "read", "write", "getaddrinfo", "lookup", "socket"].includes(value)
    ? value : undefined;
}

function failureMetadata(error: unknown): Pick<TranscriptFailureDiagnostic, "errorName" | "errorCode" | "errno" | "syscall"> {
  const result: Pick<TranscriptFailureDiagnostic, "errorName" | "errorCode" | "errno" | "syscall"> = {};
  let current = error;
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth += 1) {
    const record = current as Record<string, unknown>;
    result.errorName ??= safeErrorName(record.name);
    result.errorCode ??= safeErrorCode(record.code);
    result.syscall ??= safeSyscall(record.syscall);
    if (result.errno === undefined && typeof record.errno === "number" && Number.isFinite(record.errno)) result.errno = record.errno;
    current = record.cause;
  }
  return result;
}

function retryAfterMs(headers: TranscriptFetchResponse["headers"]): number | undefined {
  const value = headers?.get("retry-after");
  if (value === null || value === undefined) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 5_000) : undefined;
}

export type YouTubeTranscriptServiceOptions = {
  proxy?: WebshareProxyCredentials;
  fetcher?: TranscriptFetcher;
  dispatcher?: Dispatcher;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  overallTimeoutMs?: number;
  retryDelayMs?: number;
  random?: () => number;
  onAttempt?: (event: TranscriptAttemptEvent) => void | Promise<void>;
};

export class YouTubeTranscriptService {
  private readonly fetcher: TranscriptFetcher;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly ownedDispatcher: ProxyAgent | undefined;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly overallTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly random: () => number;
  private readonly onAttempt: YouTubeTranscriptServiceOptions["onAttempt"];
  private readonly proxyCredentials: WebshareProxyCredentials | undefined;

  constructor(options: YouTubeTranscriptServiceOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.dispatcher = options.dispatcher;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 10_000);
    this.overallTimeoutMs = Math.max(1, options.overallTimeoutMs ?? YOUTUBE_TRANSCRIPT_OVERALL_TIMEOUT_MS);
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 150);
    this.random = options.random ?? Math.random;
    this.onAttempt = options.onAttempt;
    this.proxyCredentials = options.proxy;
    this.ownedDispatcher = options.dispatcher === undefined && options.proxy !== undefined
      ? createWebshareProxyDispatcher(options.proxy)
      : undefined;
  }

  extractVideoId(urlOrId: string): string {
    return extractYouTubeVideoId(urlOrId);
  }

  async close(): Promise<void> {
    await this.ownedDispatcher?.close();
  }

  /** Static configuration inspection only; connectivity is never probed. */
  getProxyDiagnostic(): TranscriptProxyDiagnostic {
    const mode = this.proxyCredentials !== undefined ? "webshare" : this.dispatcher !== undefined ? "custom" : "direct";
    const usernamePresent = this.proxyCredentials !== undefined && this.proxyCredentials.username.trim() !== "";
    const passwordPresent = this.proxyCredentials !== undefined && this.proxyCredentials.password.trim() !== "";
    return Object.freeze({
      mode,
      configured: mode === "custom" || (mode === "webshare" && usernamePresent && passwordPresent),
      credentialStatus: mode !== "webshare" ? "not_applicable" : usernamePresent && passwordPresent ? "present" : "missing",
      dispatcherStatus: this.ownedDispatcher !== undefined ? "owned" : this.dispatcher !== undefined ? "injected" : "none",
      connectivity: "not_checked",
    });
  }

  private emitAttempt(event: TranscriptAttemptEvent): void {
    try {
      const result = this.onAttempt?.(Object.freeze(event));
      void result?.catch(() => undefined);
    } catch {
      // Telemetry must not alter transcript fetch results.
    }
  }

  private async request<T>(
    stage: TranscriptFailureDiagnostic["stage"],
    deadline: number,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let attempts = 0;
    let lastFailure: RequestFailure = { classification: "network" };
    while (attempts < this.maxAttempts && Date.now() < deadline) {
      attempts += 1;
      const startedAt = Date.now();
      const remaining = deadline - startedAt;
      const controller = new AbortController();
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeoutMs = Math.min(this.requestTimeoutMs, remaining);
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new TranscriptRequestFailure({ classification: "timeout" }));
        }, timeoutMs);
      });
      try {
        const value = await Promise.race([operation(controller.signal), timeout]);
        this.emitAttempt({ stage, attempt: attempts, outcome: "success", durationMs: Math.max(0, Date.now() - startedAt) });
        return value;
      } catch (error) {
        if (error instanceof TranscriptRequestFailure) lastFailure = error.failure;
        else if (error instanceof Error && isTranscriptContentError(error)) throw error;
        else if (error instanceof SyntaxError || (error instanceof Error && error.message === "caption response contained no transcript segments")) {
          lastFailure = { classification: "upstream", retryable: true };
        } else {
          lastFailure = { classification: timedOut ? "timeout" : "network", error };
        }
        const shouldRetry = lastFailure.retryable === true || lastFailure.classification === "network"
          || lastFailure.classification === "timeout" || lastFailure.classification === "rate_limited"
          || (lastFailure.classification === "upstream" && [500, 502, 503, 504].includes(lastFailure.httpStatus ?? 0));
        const willRetry = shouldRetry && attempts < this.maxAttempts && Date.now() < deadline;
        this.emitAttempt({
          stage, attempt: attempts, outcome: willRetry ? "retry" : "failure",
          classification: lastFailure.classification,
          durationMs: Math.max(0, Date.now() - startedAt),
          ...(lastFailure.httpStatus === undefined ? {} : { httpStatus: lastFailure.httpStatus }),
        });
        if (!willRetry) break;
        const random = Math.max(0, Math.min(1, this.random()));
        const backoff = Math.min(5_000, this.retryDelayMs * (2 ** (attempts - 1)) * (0.5 + random));
        const delay = lastFailure.retryAfterMs === undefined ? backoff : Math.max(backoff, lastFailure.retryAfterMs);
        await new Promise((resolve) => setTimeout(resolve, Math.min(delay, Math.max(0, deadline - Date.now()))));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    const diagnostic: TranscriptFailureDiagnostic = {
      stage,
      classification: lastFailure.classification,
      attempts,
      ...(lastFailure.httpStatus === undefined ? {} : { httpStatus: lastFailure.httpStatus }),
      ...failureMetadata(lastFailure.error),
    };
    throw new TranscriptUpstreamUnavailable(
      "YouTube request failed. This may indicate a transient upstream or proxy connection issue. Check proxy configuration.",
      diagnostic,
    );
  }

  async fetchTranscript(videoId: string, languages: readonly string[] = ["en"]): Promise<YouTubeTranscript> {
    const dispatcher = this.dispatcher ?? this.ownedDispatcher;
    const deadline = Date.now() + this.overallTimeoutMs;
    let currentStage: TranscriptFailureDiagnostic["stage"] = "watch";
    try {
      const apiKey = await this.request("watch", deadline, async (signal) => {
        const response = await this.fetcher(`${YOUTUBE_WATCH_URL}${encodeURIComponent(videoId)}`, {
          headers: { "user-agent": "Mozilla/5.0" }, dispatcher, signal,
        });
        if (!response.ok) {
          if (response.status === 404) throw new Error(`Video unavailable: ${videoId}`);
          const classification = response.status === 429 ? "rate_limited" : response.status === 403 ? "blocked" : "upstream";
          throw new TranscriptRequestFailure({
            classification, httpStatus: response.status,
            retryAfterMs: [429, 503].includes(response.status) ? retryAfterMs(response.headers) : undefined,
          });
        }
        const watchHtml = await response.text();
        const apiKey = innertubeApiKeyFromWatchPage(watchHtml);
        if (apiKey === undefined) throw new TranscriptRequestFailure({ classification: "upstream", retryable: true });
        return apiKey;
      });
      currentStage = "player";
      const playerResponse = await this.request("player", deadline, async (signal) => {
        const response = await this.fetcher(`${YOUTUBE_PLAYER_URL}${encodeURIComponent(apiKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://www.youtube.com", "user-agent": "Mozilla/5.0" },
          body: JSON.stringify({ context: { client: { clientName: YOUTUBE_CLIENT_NAME, clientVersion: YOUTUBE_CLIENT_VERSION } }, videoId }),
          dispatcher, signal,
        });
        if (!response.ok) {
          const classification = response.status === 429 ? "rate_limited" : response.status === 403 ? "blocked" : "upstream";
          throw new TranscriptRequestFailure({
            classification, httpStatus: response.status,
            retryAfterMs: [429, 503].includes(response.status) ? retryAfterMs(response.headers) : undefined,
          });
        }
        const parsed = parsePlayerResponse(await response.json());
        if (parsed === undefined) throw new TranscriptRequestFailure({ classification: "upstream", retryable: true });
        return parsed;
      });

      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks === undefined) throw transcriptUnavailableError(playerResponse, videoId);
      const track = selectCaptionTrack(tracks, languages);
      if (track === undefined) throw new Error(`No transcript found for video: ${videoId}`);

      currentStage = "captions";
      const captionUrl = track.baseUrl.replace("&fmt=srv3", "");
      const segments = await this.request("captions", deadline, async (signal) => {
        const captionResponse = await this.fetcher(captionUrl, { dispatcher, signal });
        if (!captionResponse.ok) {
          const classification = captionResponse.status === 429 ? "rate_limited" : captionResponse.status === 403 ? "blocked" : "upstream";
          throw new TranscriptRequestFailure({
            classification, httpStatus: captionResponse.status,
            retryAfterMs: [429, 503].includes(captionResponse.status) ? retryAfterMs(captionResponse.headers) : undefined,
          });
        }
        const body = await captionResponse.text();
        const parsed = captionUrl.includes("fmt=json3")
          ? parseTranscriptJson3(JSON.parse(body) as unknown)
          : parseTranscriptXml(body);
        if (parsed.length === 0) throw new TranscriptRequestFailure({ classification: "upstream", retryable: true });
        return parsed;
      });
      return {
        videoId,
        segments,
        language: languages[0] ?? "en",
        fullText: transcriptFullText(segments),
        timestampedText: transcriptTimestampedText(segments),
      };
    } catch (error) {
      if (error instanceof TranscriptUpstreamUnavailable) throw error;
      if (error instanceof Error && isTranscriptContentError(error)) throw error;
      const diagnostic: TranscriptFailureDiagnostic = {
        stage: currentStage,
        classification: "upstream",
        attempts: 1,
        ...failureMetadata(error),
      };
      throw new TranscriptUpstreamUnavailable(
        "YouTube request failed. This may indicate an upstream or proxy connection issue. Check proxy configuration.",
        diagnostic,
      );
    }
  }
}
