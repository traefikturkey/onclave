import type { Dispatcher } from "undici";
import { describe, expect, it } from "vitest";
import { DoclingClient } from "../src/vault/docling";
import {
  UrlDetector,
  applyHeuristicFilter,
  extractYouTubeVideoId,
  isBlockedByHeuristic,
} from "../src/vault/url-detector";
import {
  YouTubeTranscriptService,
  type TranscriptFetchInit,
  parseTranscriptJson3,
  parseTranscriptXml,
  selectCaptionTrack,
  transcriptFullText,
  YOUTUBE_TRANSCRIPT_OVERALL_TIMEOUT_MS,
  type TranscriptAttemptEvent,
} from "../src/vault/youtube-transcript";
import { YouTubeMetadataService, formatDuration, parseDurationToSeconds } from "../src/vault/youtube-metadata";

type FetchCall = {
  url: string;
  init: TranscriptFetchInit;
};

function responseJson(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("YouTube URL classification", () => {
  it.each([
    ["https://www.youtube.com/watch?v=RpvQH0r0ecM", "RpvQH0r0ecM"],
    ["https://youtu.be/RpvQH0r0ecM", "RpvQH0r0ecM"],
    ["https://www.youtube.com/embed/RpvQH0r0ecM", "RpvQH0r0ecM"],
    ["https://www.youtube.com/shorts/RpvQH0r0ecM", "RpvQH0r0ecM"],
    ["https://m.youtube.com/watch?v=RpvQH0r0ecM&t=123&list=xyz", "RpvQH0r0ecM"],
  ])("extracts %s", (url, expected) => {
    expect(extractYouTubeVideoId(url)).toBe(expected);
    expect(new UrlDetector().classifyUrl(url)).toEqual({ url, urlType: "youtube", extractedId: expected });
  });

  it("classifies ordinary HTTP URLs as web and rejects non-HTTP input", () => {
    const detector = new UrlDetector();
    expect(detector.classifyUrl("https://example.com/article")).toEqual({
      url: "https://example.com/article",
      urlType: "web",
      extractedId: "",
    });
    expect(detector.classifyUrl("not-a-valid-url").urlType).toBe("unknown");
    expect(new YouTubeTranscriptService().extractVideoId("RpvQH0r0ecM")).toBe("RpvQH0r0ecM");
  });
});

describe("URL filtering", () => {
  it("preserves the Python heuristic rules and reasons", () => {
    expect(isBlockedByHeuristic("https://gumroad.com/product")).toEqual({
      blocked: true,
      reason: "Blocked domain: gumroad.com",
    });
    expect(isBlockedByHeuristic("https://example.com/page?utm_source=youtube")).toEqual({
      blocked: true,
      reason: "Blocked pattern: \\?utm_",
    });
    expect(isBlockedByHeuristic("https://twitter.com/user/status/123")).toEqual({ blocked: false });
    expect(isBlockedByHeuristic("https://twitter.com/user")).toEqual({
      blocked: true,
      reason: "Social media profile (not content)",
    });
  });

  it("returns blocked and remaining URLs in input order", () => {
    expect(applyHeuristicFilter([
      "https://github.com/user/repo",
      "https://bit.ly/abc123",
      "https://docs.python.org/3/library/re.html",
    ])).toEqual({
      blocked: [{ url: "https://bit.ly/abc123", reason: "Blocked domain: bit.ly" }],
      remaining: ["https://github.com/user/repo", "https://docs.python.org/3/library/re.html"],
    });
  });
});

describe("YouTube transcript parsing and retrieval", () => {
  it("parses XML segments and keeps the Python plain-text join behavior", () => {
    const segments = parseTranscriptXml(
      '<transcript><text start="0" dur="1.5">Hello &amp; welcome</text><text start="1.5" dur="2">world</text></transcript>',
    );
    expect(segments).toEqual([
      { text: "Hello & welcome", start: 0, duration: 1.5 },
      { text: "world", start: 1.5, duration: 2 },
    ]);
    expect(transcriptFullText(segments)).toBe("Hello & welcome world");
  });

  it("parses json3 segments", () => {
    expect(parseTranscriptJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Hello " }, { utf8: "world" }] },
        { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: "!" }] },
      ],
    })).toEqual([
      { text: "Hello world", start: 0, duration: 1.5 },
      { text: "!", start: 1.5, duration: 0.5 },
    ]);
  });

  it("uses requested language order and prefers manual transcripts over ASR", () => {
    const tracks = [
      { baseUrl: "https://captions/en-asr", languageCode: "en", kind: "asr" },
      { baseUrl: "https://captions/es", languageCode: "es" },
      { baseUrl: "https://captions/en", languageCode: "en" },
    ];
    expect(selectCaptionTrack(tracks, ["es", "en"])?.baseUrl).toBe("https://captions/es");
    expect(selectCaptionTrack(tracks, ["en", "es"])?.baseUrl).toBe("https://captions/en");
  });

  it("fetches a selected XML track through the supplied dispatcher", async () => {
    const calls: FetchCall[] = [];
    const dispatcher = {} as Dispatcher;
    const service = new YouTubeTranscriptService({
      dispatcher,
      fetcher: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.includes("watch")) {
          return new Response('<script>var ytcfg = {"INNERTUBE_API_KEY":"test-key"};</script>');
        }
        if (url.includes("youtubei")) {
          return responseJson({
            playabilityStatus: { status: "OK" },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://captions.example/en?signature=abc&fmt=srv3", languageCode: "en" }] } },
          });
        }
        return new Response('<transcript><text start="0" dur="1">Hello</text></transcript>');
      },
    });

    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({
      language: "en",
      fullText: "Hello",
      segments: [{ text: "Hello", start: 0, duration: 1 }],
    });
    expect(calls).toHaveLength(3);
    expect(calls[0]?.init.dispatcher).toBe(dispatcher);
    expect(calls[1]?.init.dispatcher).toBe(dispatcher);
    expect(calls[2]?.url).toBe("https://captions.example/en?signature=abc");
    expect(calls[2]?.init.dispatcher).toBe(dispatcher);
  });

  it("retries transient HTTP failures within the attempt budget and keeps diagnostics structural", async () => {
    let watchAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 3,
      retryDelayMs: 0,
      random: () => 0,
      fetcher: async (url) => {
        if (url.includes("watch")) {
          watchAttempts += 1;
          if (watchAttempts === 1) return new Response("secret body", { status: 503 });
          return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
        }
        if (url.includes("youtubei")) return responseJson({ captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://captions.example/en?signature=secret", languageCode: "en" }],
        } } });
        return new Response('<transcript><text start="0" dur="1">ok</text></transcript>');
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(watchAttempts).toBe(2);
  });

  it("retries a malformed successful watch page and emits retry rather than false success", async () => {
    const events: TranscriptAttemptEvent[] = [];
    let watchAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2, retryDelayMs: 0, onAttempt: (event) => { events.push(event); },
      fetcher: async (url) => {
        if (url.includes("watch")) {
          watchAttempts += 1;
          return new Response(watchAttempts === 1 ? "<html>temporarily incomplete</html>" : '<script>{"INNERTUBE_API_KEY":"key"}</script>');
        }
        if (url.includes("youtubei")) return responseJson({ captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }],
        } } });
        return new Response('<transcript><text start="0" dur="1">ok</text></transcript>');
      },
    });

    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(events.filter((event) => event.stage === "watch")).toEqual([
      expect.objectContaining({ stage: "watch", attempt: 1, outcome: "retry", classification: "upstream" }),
      expect.objectContaining({ stage: "watch", attempt: 2, outcome: "success" }),
    ]);
  });

  it("classifies exhausted malformed watch pages as bounded upstream failures", async () => {
    const events: TranscriptAttemptEvent[] = [];
    let watchAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2, retryDelayMs: 0, onAttempt: (event) => { events.push(event); },
      fetcher: async () => { watchAttempts += 1; return new Response("<html>incomplete</html>"); },
    });
    const failure = await service.fetchTranscript("dQw4w9WgXcQ").catch((error: unknown) => error);

    expect(watchAttempts).toBe(2);
    expect(failure).toMatchObject({
      name: "TranscriptUpstreamUnavailable",
      diagnostic: { stage: "watch", classification: "upstream", attempts: 2 },
    });
    expect(events).toEqual([
      expect.objectContaining({ stage: "watch", attempt: 1, outcome: "retry", classification: "upstream" }),
      expect.objectContaining({ stage: "watch", attempt: 2, outcome: "failure", classification: "upstream" }),
    ]);
    expect(events.some((event) => event.stage === "watch" && event.outcome === "success")).toBe(false);
  });

  it("emits finite per-attempt telemetry without changing request results", async () => {
    const events: TranscriptAttemptEvent[] = [];
    let watchAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2, retryDelayMs: 0,
      onAttempt: (event) => { events.push(event); throw new Error("observer failure"); },
      fetcher: async (url) => {
        if (url.includes("watch")) {
          watchAttempts += 1;
          if (watchAttempts === 1) return new Response("", { status: 503 });
          return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
        }
        if (url.includes("youtubei")) return responseJson({ captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }],
        } } });
        return new Response('<transcript><text start="0" dur="1">ok</text></transcript>');
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(events).toEqual([
      expect.objectContaining({ stage: "watch", attempt: 1, outcome: "retry", classification: "upstream", httpStatus: 503 }),
      expect.objectContaining({ stage: "watch", attempt: 2, outcome: "success" }),
      expect.objectContaining({ stage: "player", attempt: 1, outcome: "success" }),
      expect.objectContaining({ stage: "captions", attempt: 1, outcome: "success" }),
    ]);
    for (const event of events) {
      expect(event.durationMs).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(event.durationMs)).toBe(true);
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.keys(event)).not.toContain("url");
    }
  });

  it("reports static proxy configuration without exposing credentials or probing connectivity", async () => {
    const direct = new YouTubeTranscriptService();
    expect(direct.getProxyDiagnostic()).toEqual({
      mode: "direct", configured: false, credentialStatus: "not_applicable", dispatcherStatus: "none", connectivity: "not_checked",
    });
    const custom = new YouTubeTranscriptService({ dispatcher: {} as Dispatcher });
    expect(custom.getProxyDiagnostic()).toEqual({
      mode: "custom", configured: true, credentialStatus: "not_applicable", dispatcherStatus: "injected", connectivity: "not_checked",
    });
    const webshare = new YouTubeTranscriptService({ proxy: { username: "user-private", password: "pass-private" } });
    try {
      const diagnostic = webshare.getProxyDiagnostic();
      expect(diagnostic).toEqual({
        mode: "webshare", configured: true, credentialStatus: "present", dispatcherStatus: "owned", connectivity: "not_checked",
      });
      expect(JSON.stringify(diagnostic)).not.toMatch(/user-private|pass-private/);
    } finally {
      await webshare.close();
    }
    const missing = new YouTubeTranscriptService({ proxy: { username: "", password: "" } });
    try {
      expect(missing.getProxyDiagnostic()).toMatchObject({ configured: false, credentialStatus: "missing", connectivity: "not_checked" });
    } finally {
      await missing.close();
    }
  });

  it("keeps the server deadline below the official 30-second client deadline", () => {
    expect(YOUTUBE_TRANSCRIPT_OVERALL_TIMEOUT_MS).toBeLessThan(30_000);
    expect(YOUTUBE_TRANSCRIPT_OVERALL_TIMEOUT_MS).toBeLessThanOrEqual(25_000);
  });

  it("reads only whitelisted metadata through bounded nested causes", async () => {
    const innermost = Object.assign(new Error("https://user:secret@example.test/?token=hidden"), {
      code: "ECONNRESET", errno: -104, syscall: "connect",
    });
    const middle = Object.assign(new Error("unsafe outer message"), { cause: innermost });
    const outer = Object.assign(new Error("another unsafe message"), { cause: middle });
    const service = new YouTubeTranscriptService({ maxAttempts: 1, fetcher: async () => { throw outer; } });
    const failure = await service.fetchTranscript("dQw4w9WgXcQ").catch((error: unknown) => error);
    expect(failure).toMatchObject({
      diagnostic: { classification: "network", errorName: "Error", errorCode: "ECONNRESET", errno: -104, syscall: "connect" },
    });
    expect(JSON.stringify(failure)).not.toMatch(/secret|hidden|example\.test|unsafe outer/);
  });

  it.each([
    ["invalid player schema", { playabilityStatus: { status: "OK" } }],
    ["malformed player JSON", null],
  ])("retries %s as invalid upstream", async (_label, playerBody) => {
    let playerAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2, retryDelayMs: 0,
      fetcher: async (url) => {
        if (url.includes("watch")) return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
        if (url.includes("youtubei")) {
          playerAttempts += 1;
          if (playerAttempts === 1 && playerBody === null) {
            return { ok: true, status: 200, json: async () => { throw new SyntaxError("private response URL"); }, text: async () => "" };
          }
          if (playerAttempts === 1) return responseJson(playerBody);
          return responseJson({ captions: { playerCaptionsTracklistRenderer: {
            captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }],
          } } });
        }
        return new Response('<transcript><text start="0" dur="1">ok</text></transcript>');
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(playerAttempts).toBe(2);
  });

  it.each(["empty", "malformed-json"])("retries %s caption responses", async (firstResponse) => {
    let captionAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2, retryDelayMs: 0,
      fetcher: async (url) => {
        if (url.includes("watch")) return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
        if (url.includes("youtubei")) return responseJson({ captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://captions.example/en?fmt=json3", languageCode: "en" }],
        } } });
        captionAttempts += 1;
        if (captionAttempts === 1) return new Response(firstResponse === "empty" ? '{"events":[]}' : "not json");
        return new Response('{"events":[{"tStartMs":0,"segs":[{"utf8":"ok"}]}]}');
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(captionAttempts).toBe(2);
  });

  it("honors bounded Retry-After and exponentially increases jittered retry delays", async () => {
    const retryTimes: number[] = [];
    let watchAttempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 3, retryDelayMs: 20, random: () => 1,
      fetcher: async (url) => {
        if (url.includes("youtubei")) return responseJson({ captions: { playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }],
        } } });
        if (url.includes("captions.example")) return new Response('<transcript><text start="0" dur="1">ok</text></transcript>');
        if (!url.includes("watch")) throw new Error("unexpected request");
        watchAttempts += 1;
        retryTimes.push(Date.now());
        if (watchAttempts === 1) return new Response("", { status: 429, headers: { "retry-after": "0.04" } });
        if (watchAttempts === 2) return new Response("", { status: 503, headers: { "retry-after": "0.07" } });
        return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "ok" });
    expect(watchAttempts).toBe(3);
    expect((retryTimes[1] ?? 0) - (retryTimes[0] ?? 0)).toBeGreaterThanOrEqual(35);
    expect((retryTimes[2] ?? 0) - (retryTimes[1] ?? 0)).toBeGreaterThanOrEqual(65);
  });

  it("preserves the last response classification when the deadline expires during backoff", async () => {
    let attempts = 0;
    const service = new YouTubeTranscriptService({
      maxAttempts: 3, overallTimeoutMs: 30, retryDelayMs: 1_000,
      fetcher: async () => { attempts += 1; return new Response("", { status: 429 }); },
    });
    const failure = await service.fetchTranscript("dQw4w9WgXcQ").catch((error: unknown) => error);
    expect(attempts).toBe(1);
    expect(failure).toMatchObject({ diagnostic: { classification: "rate_limited", httpStatus: 429, attempts: 1 } });
  });

  it("does not retry permanent content errors", async () => {
    let playerAttempts = 0;
    const service = new YouTubeTranscriptService({
      fetcher: async (url) => {
        if (url.includes("watch")) return new Response('<script>{"INNERTUBE_API_KEY":"key"}</script>');
        playerAttempts += 1;
        return responseJson({ playabilityStatus: { status: "ERROR", reason: "Video unavailable" } });
      },
    });
    await expect(service.fetchTranscript("dQw4w9WgXcQ")).rejects.toThrow("Video unavailable");
    expect(playerAttempts).toBe(1);
  });

  it("does not retry permanent HTTP failures and exposes only sanitized diagnostics", async () => {
    let attempts = 0;
    const service = new YouTubeTranscriptService({
      retryDelayMs: 0,
      fetcher: async () => {
        attempts += 1;
        return new Response("secret body", { status: 403 });
      },
    });
    let failure: unknown;
    try {
      await service.fetchTranscript("dQw4w9WgXcQ");
    } catch (error) {
      failure = error;
    }
    expect(attempts).toBe(1);
    expect(failure).toMatchObject({
      name: "TranscriptUpstreamUnavailable",
      diagnostic: { stage: "watch", classification: "blocked", attempts: 1, httpStatus: 403 },
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("aborts timed-out requests and reports a bounded timeout diagnostic", async () => {
    let aborted = false;
    const service = new YouTubeTranscriptService({
      maxAttempts: 2,
      requestTimeoutMs: 5,
      overallTimeoutMs: 100,
      retryDelayMs: 0,
      random: () => 0,
      fetcher: (_url, init) => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(Object.assign(new Error("https://user:pass@example.test/?token=secret"), { code: "ETIMEDOUT" }));
        });
      }),
    });
    let failure: unknown;
    try {
      await service.fetchTranscript("dQw4w9WgXcQ");
    } catch (error) {
      failure = error;
    }
    expect(aborted).toBe(true);
    expect(failure).toMatchObject({
      name: "TranscriptUpstreamUnavailable",
      diagnostic: { stage: "watch", classification: "timeout", attempts: 2 },
    });
    expect(JSON.stringify(failure)).not.toContain("secret");
  });

  it("reuses an owned proxy dispatcher across sequential transcript fetches", async () => {
    const service = new YouTubeTranscriptService({
      proxy: { username: "test-user", password: "test-password" },
      fetcher: async (url) => {
        if (url.includes("watch")) {
          return new Response('<script>var ytcfg = {"INNERTUBE_API_KEY":"test-key"};</script>');
        }
        if (url.includes("youtubei")) {
          return responseJson({
            playabilityStatus: { status: "OK" },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }] } },
          });
        }
        return new Response('<transcript><text start="0" dur="1">Hello</text></transcript>');
      },
    });

    try {
      await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "Hello" });
      await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "Hello" });
    } finally {
      await service.close();
    }
  });

  it("uses the Android player response instead of watch page caption data", async () => {
    const calls: FetchCall[] = [];
    const service = new YouTubeTranscriptService({
      fetcher: async (url, init = {}) => {
        calls.push({ url, init });
        if (url.includes("watch")) {
          return new Response(
            '<script>var ytcfg = {"INNERTUBE_API_KEY":"test-key"}; var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://captions.example/stale","languageCode":"en"}]}}};</script>',
          );
        }
        if (url.includes("youtubei")) {
          return responseJson({
            playabilityStatus: { status: "OK" },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }] } },
          });
        }
        return new Response('<transcript><text start="0" dur="1">Hello</text></transcript>');
      },
    });

    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({ fullText: "Hello" });
    expect(calls[1]?.url).toBe("https://www.youtube.com/youtubei/v1/player?key=test-key");
    expect(JSON.parse(calls[1]?.init.body ?? "{}")).toMatchObject({
      context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
      videoId: "dQw4w9WgXcQ",
    });
    expect(calls[2]?.url).toBe("https://captions.example/en");
    expect(calls).toHaveLength(3);
  });

  it("rejects caption responses without transcript segments", async () => {
    const service = new YouTubeTranscriptService({
      fetcher: async (url) => {
        if (url.includes("watch")) {
          return new Response('<script>var ytcfg = {"INNERTUBE_API_KEY":"test-key"};</script>');
        }
        if (url.includes("youtubei")) {
          return responseJson({
            playabilityStatus: { status: "OK" },
            captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: "https://captions.example/en", languageCode: "en" }] } },
          });
        }
        return new Response("<transcript></transcript>");
      },
    });

    await expect(service.fetchTranscript("dQw4w9WgXcQ")).rejects.toMatchObject({
      diagnostic: { stage: "captions", classification: "upstream", attempts: 3 },
    });
  });
});

describe("YouTube Data API metadata", () => {
  it("maps video metadata and duration fields", async () => {
    const service = new YouTubeMetadataService("test-key", async () => responseJson({
      items: [{
        snippet: {
          title: "Test Video",
          description: "See https://example.com.",
          channelId: "channel123",
          channelTitle: "Test Channel",
          publishedAt: "2024-01-01T00:00:00Z",
          tags: ["test"],
          categoryId: "24",
          thumbnails: { default: { url: "https://image.example" } },
        },
        contentDetails: { duration: "PT1H2M3S" },
        statistics: { viewCount: "100", likeCount: "5", commentCount: "2" },
      }],
    }));

    await expect(service.fetchMetadata("abc123def45")).resolves.toMatchObject({
      videoId: "abc123def45",
      title: "Test Video",
      descriptionUrls: ["https://example.com"],
      duration: "PT1H2M3S",
      durationSeconds: 3723,
      durationFormatted: "1:02:03",
      viewCount: 100,
      likeCount: 5,
      commentCount: 2,
    });
    expect(parseDurationToSeconds("invalid")).toBe(0);
    expect(formatDuration("PT45S")).toBe("0:45");
  });

  it("maps upload listings and exposes the Data API source", async () => {
    const service = new YouTubeMetadataService("test-key", async (url) => {
      if (url.includes("/search")) return responseJson({ items: [{ snippet: { channelId: "UC123" } }] });
      if (url.includes("/channels")) {
        return responseJson({ items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }] });
      }
      if (url.includes("/playlistItems")) {
        return responseJson({
          items: [{
            contentDetails: { videoId: "abc123def45" },
            snippet: { title: "Playlist title", publishedAt: "2024-01-01T00:00:00Z" },
          }],
        });
      }
      return responseJson({
        items: [{
          id: "abc123def45",
          snippet: { title: "Video title" },
          contentDetails: { duration: "PT1M2S" },
          statistics: { viewCount: "10" },
        }],
      });
    });

    await expect(service.fetchChannelVideosResponse("@example", 1)).resolves.toEqual({
      source: "youtube-data-api-v3",
      videos: [{
        videoId: "abc123def45",
        title: "Video title",
        url: "https://www.youtube.com/watch?v=abc123def45",
        publishedAt: "2024-01-01T00:00:00Z",
        duration: "1:02",
        durationSeconds: 62,
        viewCount: 10,
      }],
    });
  });
});

describe("Docling client", () => {
  it("posts the Menos source-conversion payload and extracts nested markdown", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DoclingClient("http://docling-serve:5001/", 30_000, async (url, init = {}) => {
      calls.push({ url, init });
      return responseJson({ result: { markdown: "# Title\nBody", title: "Page Title" } });
    });

    await expect(client.extractMarkdown("https://example.com/article")).resolves.toEqual({
      markdown: "# Title\nBody",
      title: "Page Title",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://docling-serve:5001/v1/convert/source");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      sources: [{ kind: "http", url: "https://example.com/article" }],
      options: { to_formats: ["md"], image_export_mode: "placeholder" },
    });
  });
});

const smokeEnabled = process.env.SMOKE_YOUTUBE === "1"
  && process.env.WEBSHARE_PROXY_USERNAME !== undefined
  && process.env.WEBSHARE_PROXY_PASSWORD !== undefined;

it.skipIf(!smokeEnabled)("fetches a real transcript through Webshare when enabled", async () => {
  const service = new YouTubeTranscriptService({
    proxy: {
      username: process.env.WEBSHARE_PROXY_USERNAME ?? "",
      password: process.env.WEBSHARE_PROXY_PASSWORD ?? "",
    },
  });
  const transcript = await service.fetchTranscript("dQw4w9WgXcQ");
  expect(transcript.fullText.length).toBeGreaterThan(0);
}, 60_000);
