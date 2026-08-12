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
          return new Response(
            '<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://captions.example/en","languageCode":"en"}]}}};</script>',
          );
        }
        return new Response('<transcript><text start="0" dur="1">Hello</text></transcript>');
      },
    });

    await expect(service.fetchTranscript("dQw4w9WgXcQ")).resolves.toMatchObject({
      language: "en",
      fullText: "Hello",
      segments: [{ text: "Hello", start: 0, duration: 1 }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.init.dispatcher).toBe(dispatcher);
    expect(calls[1]?.init.dispatcher).toBe(dispatcher);
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
