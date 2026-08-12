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
};

export type TranscriptFetchResponse = {
  ok: boolean;
  status: number;
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
const YOUTUBE_PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const YOUTUBE_CLIENT_VERSION = "2.20241126.01.00";
const WEBSHARE_PROXY_HOST = "p.webshare.io:80";
const TRANSCRIPT_UNAVAILABLE_PREFIX = "YouTube is blocking requests for video";

export class TranscriptUpstreamUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptUpstreamUnavailable";
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
    if (!isRecord(item)) continue;
    const baseUrl = readString(item.baseUrl);
    const languageCode = readString(item.languageCode);
    if (baseUrl === undefined || languageCode === undefined) continue;
    const kind = readString(item.kind);
    tracks.push(kind === undefined ? { baseUrl, languageCode } : { baseUrl, languageCode, kind });
  }
  return tracks;
}

function parsePlayerResponse(value: unknown): PlayerResponse | undefined {
  if (!isRecord(value)) return undefined;
  const response: PlayerResponse = {};
  const captions = value.captions;
  if (isRecord(captions)) {
    const renderer = captions.playerCaptionsTracklistRenderer;
    if (isRecord(renderer)) {
      response.captions = { playerCaptionsTracklistRenderer: { captionTracks: readCaptionTracks(renderer.captionTracks) } };
    }
  }
  const playabilityStatus = value.playabilityStatus;
  if (isRecord(playabilityStatus)) {
    response.playabilityStatus = {
      status: readString(playabilityStatus.status),
      reason: readString(playabilityStatus.reason),
    };
  }
  return response;
}

function playerResponseFromWatchPage(html: string): PlayerResponse | undefined {
  const marker = "ytInitialPlayerResponse";
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return undefined;
  const assignmentIndex = html.indexOf("=", markerIndex + marker.length);
  if (assignmentIndex < 0) return undefined;
  const start = html.indexOf("{", assignmentIndex + 1);
  if (start < 0) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return parsePlayerResponse(JSON.parse(html.slice(start, index + 1)));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
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

function blockedError(videoId: string, detail: string): TranscriptUpstreamUnavailable {
  return new TranscriptUpstreamUnavailable(
    `${TRANSCRIPT_UNAVAILABLE_PREFIX} ${videoId} despite using Webshare proxy. ` +
      "Ensure you have purchased 'Residential' proxies (not 'Proxy Server' or 'Static Residential'). " +
      "Check WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD in .env. " +
      `Original error: ${detail}`,
  );
}

function requestFailedError(videoId: string, detail: string): TranscriptUpstreamUnavailable {
  return new TranscriptUpstreamUnavailable(
    `YouTube request failed for video ${videoId}. This may indicate a proxy connection issue. ` +
      "Check WEBSHARE_PROXY_USERNAME and WEBSHARE_PROXY_PASSWORD in .env. " +
      `Original error: ${detail}`,
  );
}

function transcriptUnavailableError(response: PlayerResponse | undefined, videoId: string): Error {
  const status = response?.playabilityStatus?.status;
  const reason = response?.playabilityStatus?.reason;
  if (status === "ERROR" || status === "UNPLAYABLE") return new Error(`Video unavailable: ${videoId}`);
  if (status === "LOGIN_REQUIRED" && reason !== undefined) return blockedError(videoId, reason);
  return new Error(`Transcripts disabled for video: ${videoId}`);
}

function isTranscriptContentError(error: Error): boolean {
  return error.message.startsWith("Video unavailable: ")
    || error.message.startsWith("Transcripts disabled for video: ")
    || error.message.startsWith("No transcript found for video: ");
}

export type YouTubeTranscriptServiceOptions = {
  proxy?: WebshareProxyCredentials;
  fetcher?: TranscriptFetcher;
  dispatcher?: Dispatcher;
};

export class YouTubeTranscriptService {
  private readonly fetcher: TranscriptFetcher;
  private readonly dispatcher: Dispatcher | undefined;
  private readonly ownedDispatcher: ProxyAgent | undefined;

  constructor(options: YouTubeTranscriptServiceOptions = {}) {
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.dispatcher = options.dispatcher;
    this.ownedDispatcher = options.dispatcher === undefined && options.proxy !== undefined
      ? createWebshareProxyDispatcher(options.proxy)
      : undefined;
  }

  extractVideoId(urlOrId: string): string {
    return extractYouTubeVideoId(urlOrId);
  }

  async fetchTranscript(videoId: string, languages: readonly string[] = ["en"]): Promise<YouTubeTranscript> {
    const dispatcher = this.dispatcher ?? this.ownedDispatcher;
    try {
      const watchResponse = await this.fetcher(`${YOUTUBE_WATCH_URL}${encodeURIComponent(videoId)}`, {
        headers: { "user-agent": "Mozilla/5.0" },
        dispatcher,
      });
      if (!watchResponse.ok) {
        if (watchResponse.status === 403 || watchResponse.status === 429) {
          throw blockedError(videoId, `HTTP ${watchResponse.status}`);
        }
        if (watchResponse.status === 404) throw new Error(`Video unavailable: ${videoId}`);
        throw requestFailedError(videoId, `HTTP ${watchResponse.status}`);
      }

      let playerResponse = playerResponseFromWatchPage(await watchResponse.text());
      if (playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks === undefined) {
        const response = await this.fetcher(YOUTUBE_PLAYER_URL, {
          method: "POST",
          headers: { "content-type": "application/json", origin: "https://www.youtube.com", "user-agent": "Mozilla/5.0" },
          body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: YOUTUBE_CLIENT_VERSION } }, videoId }),
          dispatcher,
        });
        if (!response.ok) {
          if (response.status === 403 || response.status === 429) throw blockedError(videoId, `HTTP ${response.status}`);
          throw requestFailedError(videoId, `HTTP ${response.status}`);
        }
        playerResponse = parsePlayerResponse(await response.json());
      }

      const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks === undefined) throw transcriptUnavailableError(playerResponse, videoId);
      const track = selectCaptionTrack(tracks, languages);
      if (track === undefined) throw new Error(`No transcript found for video: ${videoId}`);

      const captionResponse = await this.fetcher(track.baseUrl, { dispatcher });
      if (!captionResponse.ok) {
        if (captionResponse.status === 403 || captionResponse.status === 429) throw blockedError(videoId, `HTTP ${captionResponse.status}`);
        throw requestFailedError(videoId, `HTTP ${captionResponse.status}`);
      }
      const body = await captionResponse.text();
      const segments = track.baseUrl.includes("fmt=json3")
        ? parseTranscriptJson3(JSON.parse(body) as unknown)
        : parseTranscriptXml(body);
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
      throw requestFailedError(videoId, error instanceof Error ? error.message : String(error));
    } finally {
      if (this.ownedDispatcher !== undefined) await this.ownedDispatcher.close();
    }
  }
}
