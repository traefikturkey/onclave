import { describe, expect, it } from "vitest";
import { isUlid, ulid } from "../src/ulid";

describe("ulid", () => {
  it("generates 26-character Crockford base32 ids", () => {
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(isUlid(id)).toBe(true);
  });

  it("orders lexicographically by timestamp", () => {
    const earlier = ulid(1000);
    const later = ulid(2000);
    expect(earlier < later).toBe(true);
  });

  it("generates unique ids for the same timestamp", () => {
    const seen = new Set<string>();
    for (let index = 0; index < 1000; index += 1) {
      seen.add(ulid(1234567890));
    }
    expect(seen.size).toBe(1000);
  });

  it("rejects out-of-range timestamps", () => {
    expect(() => ulid(-1)).toThrow();
    expect(() => ulid(2 ** 48)).toThrow();
    expect(() => ulid(1.5)).toThrow();
  });

  it("rejects non-ulid values", () => {
    expect(isUlid("not-a-ulid")).toBe(false);
    expect(isUlid("")).toBe(false);
    expect(isUlid(42)).toBe(false);
    expect(isUlid(`${ulid()}x`)).toBe(false);
  });
});
