import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CANONICALIZATION_VERSION,
  canonicalization_version,
  canonicalizeYoutubeText,
  youtubeVersionBytes,
  youtubeVersionDigest,
  youtubeVersionDigestObjectKey,
} from "../src/vault/youtube-version";

describe("YouTube version helpers", () => {
  it("canonicalizes line endings, trailing whitespace, and outer blank lines", () => {
    expect(canonicalizeYoutubeText("\r\n  title\t\rline  \n\nbody\t\r\n")).toBe("  title\nline\n\nbody\n");
    expect(canonicalizeYoutubeText("\n\r\n \t\r")).toBe("\n");
  });

  it("uses Unicode NFC equivalence", () => {
    expect(canonicalizeYoutubeText("Cafe\u0301\r\n")).toBe(canonicalizeYoutubeText("Caf\u00e9\n"));
  });

  it("emits UTF-8 bytes without a BOM and exactly one final LF", () => {
    const bytes = youtubeVersionBytes("\ufefftitle\n\n");
    expect(bytes[0]).not.toBe(0xef);
    expect(bytes.toString("utf8")).toBe("title\n");
    expect(bytes.subarray(-1)).toEqual(Buffer.from("\n"));
    expect(bytes.subarray(-2)).not.toEqual(Buffer.from("\n\n"));
  });

  it("returns a lowercase SHA-256 digest and deterministic object key", () => {
    const digest = youtubeVersionDigest("title\r\n");
    const expected = createHash("sha256").update(Buffer.from("title\n", "utf8")).digest("hex");
    expect(digest).toEqual({ canonicalization_version, sha256: expected });
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(CANONICALIZATION_VERSION).toBe(canonicalization_version);
    expect(youtubeVersionDigestObjectKey(digest)).toBe(`${canonicalization_version}:${expected}`);
  });
});
