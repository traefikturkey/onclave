export type YouTubeChannelVideo = {
  videoId: string;
  title: string;
  url: string;
  publishedAt: string;
  duration: string | null;
  durationSeconds: number | null;
  viewCount: number | null;
};

export type YouTubeMetadata = {
  videoId: string;
  title: string;
  description: string;
  descriptionUrls: string[];
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  duration: string;
  durationSeconds: number;
  durationFormatted: string;
  viewCount: number;
  likeCount: number | null;
  commentCount: number | null;
  tags: string[];
  categoryId: string | null;
  thumbnails: Record<string, unknown>;
  fetchedAt: string;
};

export type YouTubeChannelVideos = {
  source: "youtube-data-api-v3";
  videos: YouTubeChannelVideo[];
};

export type YouTubeMetadataFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const YOUTUBE_DATA_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_DATA_API_SOURCE = "youtube-data-api-v3" as const;
const DESCRIPTION_URL = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
const ISO_DURATION = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string, fallback = ""): string {
  const value = record[key];
  return typeof value === "string" ? value : fallback;
}

function integerAt(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringsAt(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function itemsAt(value: unknown): Record<string, unknown>[] {
  return isRecord(value) && Array.isArray(value.items)
    ? value.items.filter((item): item is Record<string, unknown> => isRecord(item))
    : [];
}

function cleanUrl(url: string): string {
  let result = url.replace(/[.,;:!?)]*$/, "");
  if (result.endsWith(")") && (result.match(/\(/g)?.length ?? 0) < (result.match(/\)/g)?.length ?? 0)) {
    result = result.replace(/\)+$/, "");
  }
  return result;
}

export function extractUrls(text: string): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of text.matchAll(DESCRIPTION_URL)) {
    const url = cleanUrl(match[0]);
    if (!seen.has(url)) {
      seen.add(url);
      urls.push(url);
    }
  }
  return urls;
}

export function parseDurationToSeconds(duration: string): number {
  const match = ISO_DURATION.exec(duration);
  if (match === null) return 0;
  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const seconds = Number.parseInt(match[3] ?? "0", 10);
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatDuration(duration: string): string {
  const match = ISO_DURATION.exec(duration);
  if (match === null) return duration;
  const hours = Number.parseInt(match[1] ?? "0", 10);
  const minutes = Number.parseInt(match[2] ?? "0", 10);
  const seconds = Number.parseInt(match[3] ?? "0", 10);
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export class YouTubeMetadataService {
  private readonly fetcher: YouTubeMetadataFetcher;

  constructor(private readonly apiKey: string | undefined, fetcher: YouTubeMetadataFetcher = defaultFetcher) {
    this.fetcher = fetcher;
  }

  private async request(path: string, params: Record<string, string>): Promise<unknown> {
    if (this.apiKey === undefined || this.apiKey === "") throw new Error("YouTube API key not configured");
    const query = new URLSearchParams({ ...params, key: this.apiKey });
    const response = await this.fetcher(`${YOUTUBE_DATA_API}${path}?${query.toString()}`);
    if (!response.ok) throw new Error(`YouTube Data API request failed: ${response.status} ${response.statusText}`);
    return response.json() as Promise<unknown>;
  }

  async fetchMetadata(videoId: string): Promise<YouTubeMetadata> {
    const response = await this.request("/videos", { part: "snippet,statistics,contentDetails", id: videoId });
    const video = itemsAt(response)[0];
    if (video === undefined) throw new Error(`Video not found: ${videoId}`);
    const snippet = objectAt(video, "snippet");
    const statistics = objectAt(video, "statistics");
    const contentDetails = objectAt(video, "contentDetails");
    const duration = stringAt(contentDetails, "duration");
    const description = stringAt(snippet, "description");
    return {
      videoId,
      title: stringAt(snippet, "title"),
      description,
      descriptionUrls: extractUrls(description),
      channelId: stringAt(snippet, "channelId"),
      channelTitle: stringAt(snippet, "channelTitle"),
      publishedAt: stringAt(snippet, "publishedAt"),
      duration,
      durationSeconds: parseDurationToSeconds(duration),
      durationFormatted: formatDuration(duration),
      viewCount: integerAt(statistics, "viewCount") ?? 0,
      likeCount: integerAt(statistics, "likeCount") ?? null,
      commentCount: integerAt(statistics, "commentCount") ?? null,
      tags: stringsAt(snippet, "tags"),
      categoryId: stringAt(snippet, "categoryId") || null,
      thumbnails: objectAt(snippet, "thumbnails"),
      fetchedAt: new Date().toISOString(),
    };
  }

  async resolveChannelId(channel: string): Promise<string> {
    const normalized = channel.trim().replace(/\/$/, "");
    const channelMatch = /youtube\.com\/channel\/([^/?#]+)/.exec(normalized);
    if (channelMatch?.[1] !== undefined) return channelMatch[1];

    let handle: string;
    const urlHandle = /youtube\.com\/@([^/?#]+)/.exec(normalized);
    if (urlHandle?.[1] !== undefined) {
      handle = urlHandle[1];
    } else if (normalized.startsWith("@")) {
      handle = normalized.slice(1);
    } else {
      throw new Error("channel must be an @handle or https://www.youtube.com/@handle");
    }

    const response = await this.request("/search", { part: "snippet", q: handle, type: "channel", maxResults: "1" });
    const channelItem = itemsAt(response)[0];
    const channelId = channelItem === undefined ? "" : stringAt(objectAt(channelItem, "snippet"), "channelId");
    if (channelId === "") throw new Error(`No channel found for @${handle}`);
    return channelId;
  }

  async fetchChannelVideos(channel: string, limit = 50): Promise<YouTubeChannelVideo[]> {
    const channelId = await this.resolveChannelId(channel);
    const channels = await this.request("/channels", { part: "contentDetails", id: channelId });
    const channelItem = itemsAt(channels)[0];
    const uploads = channelItem === undefined
      ? ""
      : stringAt(objectAt(objectAt(channelItem, "contentDetails"), "relatedPlaylists"), "uploads");
    if (uploads === "") throw new Error(`No channel found with ID: ${channelId}`);

    const videoIds: string[] = [];
    const published = new Map<string, string>();
    const titles = new Map<string, string>();
    let pageToken: string | undefined;
    while (videoIds.length < limit) {
      const params: Record<string, string> = {
        part: "snippet,contentDetails",
        playlistId: uploads,
        maxResults: String(Math.min(50, limit - videoIds.length)),
      };
      if (pageToken !== undefined) params.pageToken = pageToken;
      const page = await this.request("/playlistItems", params);
      for (const item of itemsAt(page)) {
        const videoId = stringAt(objectAt(item, "contentDetails"), "videoId");
        if (videoId === "") continue;
        const snippet = objectAt(item, "snippet");
        videoIds.push(videoId);
        published.set(videoId, stringAt(snippet, "publishedAt"));
        titles.set(videoId, stringAt(snippet, "title"));
      }
      pageToken = isRecord(page) ? stringAt(page, "nextPageToken") || undefined : undefined;
      if (pageToken === undefined) break;
    }

    const details = new Map<string, Record<string, unknown>>();
    for (let index = 0; index < videoIds.length; index += 50) {
      const batch = videoIds.slice(index, index + 50);
      const response = await this.request("/videos", { part: "snippet,statistics,contentDetails", id: batch.join(",") });
      for (const item of itemsAt(response)) {
        const id = stringAt(item, "id");
        if (id !== "") details.set(id, item);
      }
    }

    return videoIds.map((videoId) => {
      const item = details.get(videoId);
      if (item === undefined) {
        return {
          videoId,
          title: titles.get(videoId) ?? "",
          url: `https://www.youtube.com/watch?v=${videoId}`,
          publishedAt: published.get(videoId) ?? "",
          duration: null,
          durationSeconds: null,
          viewCount: null,
        };
      }
      const duration = stringAt(objectAt(item, "contentDetails"), "duration");
      return {
        videoId,
        title: stringAt(objectAt(item, "snippet"), "title", titles.get(videoId) ?? ""),
        url: `https://www.youtube.com/watch?v=${videoId}`,
        publishedAt: published.get(videoId) ?? "",
        duration: formatDuration(duration),
        durationSeconds: parseDurationToSeconds(duration),
        viewCount: integerAt(objectAt(item, "statistics"), "viewCount") ?? null,
      };
    });
  }

  async fetchChannelVideosResponse(channel: string, limit = 50): Promise<YouTubeChannelVideos> {
    return { source: YOUTUBE_DATA_API_SOURCE, videos: await this.fetchChannelVideos(channel, limit) };
  }

  async fetchMetadataSafe(videoId: string): Promise<{ metadata: YouTubeMetadata | null; error: string | null }> {
    try {
      return { metadata: await this.fetchMetadata(videoId), error: null };
    } catch (error) {
      return { metadata: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
