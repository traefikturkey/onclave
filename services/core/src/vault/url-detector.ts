export type UrlType = "github_repo" | "arxiv" | "doi" | "pypi" | "npm" | "youtube" | "web" | "unknown";

export type DetectedUrl = {
  url: string;
  urlType: UrlType;
  extractedId: string;
};

export type BlockedUrl = {
  url: string;
  reason: string;
};

export type UrlFilterResult = {
  blocked: BlockedUrl[];
  remaining: string[];
};

const YOUTUBE_ID = /^[0-9A-Za-z_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const BLOCKED_DOMAINS = [
  "gumroad.com",
  "patreon.com/join",
  "ko-fi.com",
  "buymeacoffee.com",
  "circle.so/checkout",
  "memberful.com",
  "teachable.com",
  "bit.ly",
  "tinyurl.com",
  "amzn.to",
  "amazon.com/dp",
  "shareasale.com",
  "linksynergy.com",
  "linktree",
  "beacons.ai",
  "linktr.ee",
  "bio.link",
  "hoo.be",
  "carrd.co",
] as const;
const BLOCKED_URL_PATTERNS = [
  "checkout",
  "buy",
  "order",
  "cart",
  "payment",
  "subscribe",
  "join",
  "membership",
  "\\?ref=",
  "\\?affiliate=",
  "\\?utm_",
  "amzn\\.to",
] as const;
const SOCIAL_PROFILE_PATTERNS = [
  "twitter\\.com/[^/]+$",
  "x\\.com/[^/]+$",
  "instagram\\.com/[^/]+/?$",
  "tiktok\\.com/@[^/]+$",
  "facebook\\.com/[^/]+$",
  "linkedin\\.com/in/[^/]+$",
  "youtube\\.com/@[^/]+$",
  "youtube\\.com/c/[^/]+$",
] as const;

const GITHUB_REPO = /https?:\/\/github\.com\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+?)(?:\.git)?(?:\/|\s|\)|\?|#|$)/g;
const ARXIV = /https?:\/\/arxiv\.org\/abs\/(\d{4}\.\d{4,5}(?:v\d+)?)/g;
const DOI = /https?:\/\/doi\.org\/(10\.\d{4,}\/[^\s<>"]+?)(?:\s|<|>|"|$)/g;
const PYPI = /https?:\/\/pypi\.org\/project\/([a-zA-Z0-9_-]+)\/?(?:\s|\)|\?|#|$)/g;
const NPM = /https?:\/\/(?:www\.)?npmjs\.com\/package\/([@a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)?)\/?(?:\s|\)|\?|#|$)/g;

type PositionedUrl = {
  index: number;
  detected: DetectedUrl;
};

function matchedUrls(pattern: RegExp, text: string): RegExpMatchArray[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)];
}

function validYouTubeId(candidate: string | undefined): string | undefined {
  return candidate !== undefined && YOUTUBE_ID.test(candidate) ? candidate : undefined;
}

/** Extracts the video id from the YouTube URL forms accepted by Menos. */
export function extractYouTubeVideoId(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }

  const host = parsed.hostname.toLowerCase();
  if (host === "youtu.be") {
    return validYouTubeId(parsed.pathname.split("/").filter(Boolean)[0]);
  }
  if (!YOUTUBE_HOSTS.has(host)) return undefined;

  const queryId = validYouTubeId(parsed.searchParams.get("v") ?? undefined);
  if (queryId !== undefined) return queryId;

  const parts = parsed.pathname.split("/").filter(Boolean);
  if ((parts[0] === "shorts" || parts[0] === "embed") && parts.length >= 2) {
    return validYouTubeId(parts[1]);
  }
  return undefined;
}

/** Applies the Menos description URL marketing and social-profile heuristics. */
export function isBlockedByHeuristic(url: string): { blocked: boolean; reason?: string } {
  const lowered = url.toLowerCase();
  for (const domain of BLOCKED_DOMAINS) {
    if (lowered.includes(domain)) return { blocked: true, reason: `Blocked domain: ${domain}` };
  }
  for (const pattern of BLOCKED_URL_PATTERNS) {
    if (new RegExp(pattern).test(lowered)) {
      return { blocked: true, reason: `Blocked pattern: ${pattern}` };
    }
  }
  for (const pattern of SOCIAL_PROFILE_PATTERNS) {
    if (new RegExp(pattern).test(lowered)) {
      return { blocked: true, reason: "Social media profile (not content)" };
    }
  }
  return { blocked: false };
}

export function applyHeuristicFilter(urls: readonly string[]): UrlFilterResult {
  const blocked: BlockedUrl[] = [];
  const remaining: string[] = [];
  for (const url of urls) {
    const result = isBlockedByHeuristic(url);
    if (result.blocked) {
      blocked.push({ url, reason: result.reason ?? "Blocked" });
    } else {
      remaining.push(url);
    }
  }
  return { blocked, remaining };
}

/** Port of the Menos URL detector used to choose the ingest pipeline. */
export class UrlDetector {
  detectUrls(text: string): DetectedUrl[] {
    const detected: PositionedUrl[] = [];
    for (const match of matchedUrls(GITHUB_REPO, text)) {
      const owner = match[1];
      const repository = match[2];
      if (owner === undefined || repository === undefined || match.index === undefined) continue;
      const protocol = match[0].startsWith("https") ? "https" : "http";
      detected.push({
        index: match.index,
        detected: {
          url: `${protocol}://github.com/${owner}/${repository}`,
          urlType: "github_repo",
          extractedId: `${owner}/${repository}`,
        },
      });
    }
    for (const match of matchedUrls(ARXIV, text)) {
      if (match[1] === undefined || match.index === undefined) continue;
      detected.push({
        index: match.index,
        detected: { url: match[0].replace(/[ \t\r\n)]+$/, ""), urlType: "arxiv", extractedId: match[1] },
      });
    }
    for (const match of matchedUrls(DOI, text)) {
      if (match[1] === undefined || match.index === undefined) continue;
      detected.push({
        index: match.index,
        detected: {
          url: match[0].replace(/[ \t\r\n<>".)]+$/, ""),
          urlType: "doi",
          extractedId: match[1],
        },
      });
    }
    for (const match of matchedUrls(PYPI, text)) {
      if (match[1] === undefined || match.index === undefined) continue;
      const protocol = match[0].startsWith("https") ? "https" : "http";
      detected.push({
        index: match.index,
        detected: { url: `${protocol}://pypi.org/project/${match[1]}`, urlType: "pypi", extractedId: match[1] },
      });
    }
    for (const match of matchedUrls(NPM, text)) {
      if (match[1] === undefined || match.index === undefined) continue;
      const protocol = match[0].startsWith("https") ? "https" : "http";
      const www = match[0].includes("www.") ? "www." : "";
      detected.push({
        index: match.index,
        detected: { url: `${protocol}://${www}npmjs.com/package/${match[1]}`, urlType: "npm", extractedId: match[1] },
      });
    }
    detected.sort((left, right) => left.index - right.index);
    return detected.map(({ detected: result }) => result);
  }

  classifyUrl(url: string): DetectedUrl {
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return { url, urlType: "unknown", extractedId: "" };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { url, urlType: "unknown", extractedId: "" };
    }
    const videoId = extractYouTubeVideoId(trimmed);
    if (videoId !== undefined) return { url, urlType: "youtube", extractedId: videoId };
    return this.detectUrls(url)[0] ?? { url, urlType: "web", extractedId: "" };
  }
}
