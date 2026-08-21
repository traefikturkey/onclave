import { createHash } from "node:crypto";

export const canonicalization_version = "youtube-text-v1" as const;
export const CANONICALIZATION_VERSION = canonicalization_version;

export type YoutubeVersionDigest = {
  canonicalization_version: typeof canonicalization_version;
  sha256: string;
};

export function canonicalizeYoutubeText(input: string): string {
  const lines = input.normalize("NFC").replace(/^\ufeff/, "").replace(/\r\n?/g, "\n").split("\n");
  const trimmedLines = lines.map((line) => line.replace(/[ \t]+$/g, ""));
  let first = 0;
  let last = trimmedLines.length;
  while (first < last && trimmedLines[first] === "") first += 1;
  while (last > first && trimmedLines[last - 1] === "") last -= 1;
  return `${trimmedLines.slice(first, last).join("\n")}\n`;
}

export function youtubeVersionBytes(input: string): Buffer {
  return Buffer.from(canonicalizeYoutubeText(input), "utf8");
}

export function youtubeVersionDigest(input: string): YoutubeVersionDigest {
  const sha256 = createHash("sha256").update(youtubeVersionBytes(input)).digest("hex");
  return { canonicalization_version, sha256 };
}

export function youtubeVersionDigestObjectKey(digest: YoutubeVersionDigest): string {
  return `${digest.canonicalization_version}:${digest.sha256}`;
}
