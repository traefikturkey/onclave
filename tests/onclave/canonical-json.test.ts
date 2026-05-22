import { describe, expect, it } from "bun:test";
import { canonicalJson } from "../../src/onclave/canonical-json";

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it("sorts nested object keys without changing array order", () => {
    const left = { z: [{ b: 2, a: 1 }], a: { d: 4, c: 3 } };
    const right = { a: { c: 3, d: 4 }, z: [{ a: 1, b: 2 }] };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe('{"a":{"c":3,"d":4},"z":[{"a":1,"b":2}]}');
  });

  it("rejects undefined values because signed payloads must be explicit", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/finite/);
    expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(/finite/);
  });
});
