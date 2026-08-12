import { HttpError } from "./errors";

export type DoclingResult = {
  markdown: string;
  title: string | null;
};

export type DoclingFetcher = (url: string, init?: RequestInit) => Promise<Response>;

const MARKDOWN_KEYS = ["markdown", "md", "md_content"] as const;
const NESTED_KEYS = ["document", "documents", "output", "outputs", "data"] as const;
const TITLE_NESTED_KEYS = ["result", ...NESTED_KEYS] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function extractMarkdown(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    for (const item of data) {
      const markdown = extractMarkdown(item);
      if (markdown !== undefined) return markdown;
    }
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  for (const key of MARKDOWN_KEYS) {
    const markdown = nonemptyString(data[key]);
    if (markdown !== undefined) return markdown;
  }
  for (const key of ["result", ...NESTED_KEYS]) {
    if (!(key in data)) continue;
    const markdown = extractMarkdown(data[key]);
    if (markdown !== undefined) return markdown;
  }
  return undefined;
}

export function extractTitle(data: unknown): string | undefined {
  if (Array.isArray(data)) {
    for (const item of data) {
      const title = extractTitle(item);
      if (title !== undefined) return title;
    }
    return undefined;
  }
  if (!isRecord(data)) return undefined;
  const direct = nonemptyString(data.title);
  if (direct !== undefined) return direct;
  if (isRecord(data.metadata)) {
    const metadataTitle = nonemptyString(data.metadata.title);
    if (metadataTitle !== undefined) return metadataTitle;
  }
  for (const key of TITLE_NESTED_KEYS) {
    if (!(key in data)) continue;
    const title = extractTitle(data[key]);
    if (title !== undefined) return title;
  }
  return undefined;
}

export function extractTitleFromMarkdown(markdown: string): string | undefined {
  for (const line of markdown.split(/\r?\n/)) {
    const stripped = line.trim();
    if (stripped.startsWith("#")) return stripped.replace(/^#+/, "").trim() || undefined;
  }
  return undefined;
}

function defaultFetcher(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

export class DoclingClient {
  private readonly baseUrl: string;
  private readonly fetcher: DoclingFetcher;

  constructor(baseUrl: string, private readonly timeoutMs = 30_000, fetcher: DoclingFetcher = defaultFetcher) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetcher = fetcher;
  }

  async extractMarkdown(url: string): Promise<DoclingResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl}/v1/convert/source`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sources: [{ kind: "http", url }],
          options: { to_formats: ["md"], image_export_mode: "placeholder" },
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      const markdown = extractMarkdown(data);
      if (markdown === undefined || markdown === "") {
        throw new HttpError(503, "Docling returned no markdown");
      }
      return {
        markdown,
        title: extractTitle(data) ?? extractTitleFromMarkdown(markdown) ?? null,
      };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(503, "Docling service unavailable");
    } finally {
      clearTimeout(timeout);
    }
  }
}
