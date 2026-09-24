import { afterEach, describe, expect, it, vi } from "vitest";
import { log } from "../src/log";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("structured logging", () => {
  it("preserves useful safe fields while reserved fields cannot replace the envelope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T03:04:05.000Z"));
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);

    log("info", "core.state_loaded", {
      ts: "forged",
      level: "error",
      event: "forged.event",
      agents: 3,
      connected: true,
      signal: "SIGTERM",
      queues: ["core.rpc", "core.dead-letter"],
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      agents: 3,
      connected: true,
      signal: "SIGTERM",
      queues: ["core.rpc", "core.dead-letter"],
      ts: "2026-01-02T03:04:05.000Z",
      level: "info",
      event: "core.state_loaded",
    });
  });

  it("redacts arbitrary messages, URLs, bodies, credentials, and signatures recursively", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
    const secret = "credential-that-must-not-appear";
    const failure = Object.assign(new TypeError(`upstream failed: https://user:${secret}@example.invalid/path`), { code: "ECONNRESET" });

    log("error", "provider.request_failed", {
      message: `upstream body ${secret}`,
      url: `https://user:${secret}@example.invalid/path`,
      callbackSignature: secret,
      requestBody: { transcript: secret },
      nested: { authorization: `Bearer ${secret}`, safeCode: "LLM_CALL_ERROR" },
      failure,
      errorCode: "ECONNRESET",
      jobId: "job-safe-1",
    });

    const line = String(write.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      message: "[REDACTED]",
      url: "[REDACTED]",
      callbackSignature: "[REDACTED]",
      requestBody: "[REDACTED]",
      nested: { authorization: "[REDACTED]", safeCode: "LLM_CALL_ERROR" },
      failure: { name: "TypeError", code: "ECONNRESET" },
      errorCode: "ECONNRESET",
      jobId: "job-safe-1",
      level: "error",
      event: "provider.request_failed",
    });
    expect(line).not.toContain(secret);
    expect(line).not.toContain("example.invalid");
    expect(line).not.toContain("upstream failed");
    expect(line).not.toContain("Bearer");
  });

  it("normalizes unsupported runtime envelope values without invoking unsafe serialization", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
    const circular: Record<string, unknown> = { safe: "value" };
    circular.self = circular;
    const throwing = Object.defineProperty({}, "unsafe", { enumerable: true, get: () => { throw new Error("getter secret"); } });

    log("verbose" as never, "https://user:secret@example.invalid/event", {
      circular,
      throwing,
      notFinite: Number.POSITIVE_INFINITY,
      unsupported: 1n,
    });

    const line = String(write.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toMatchObject({
      circular: { safe: "value", self: "[Circular]" },
      throwing: {},
      level: "info",
      event: "invalid_event",
    });
    expect(line).not.toContain("getter secret");
    expect(line).not.toContain("user:secret");
    expect(line).not.toContain("Infinity");
  });
});
