import { describe, expect, it } from "vitest";
import { TRANSCRIPT_HEALTH_HISTORY_LIMIT, TranscriptHealthTracker } from "../src/vault/transcript-health";

const failure = { videoId: "video-123", stage: "captions", classification: "network", attempts: 3, httpStatus: 503,
  errorName: "TypeError", errorCode: "ECONNRESET", errno: -4077, syscall: "connect" };

describe("TranscriptHealthTracker", () => {
  it("starts healthy with empty history", () => {
    const tracker = new TranscriptHealthTracker();
    expect(tracker.snapshot()).toEqual({
      degraded: false,
      degradedSince: null,
      failureCount: 0,
      recoveryCount: 0,
      firstFailureAt: null,
      lastFailureAt: null,
      lastRecoveryAt: null,
      lastFailure: null,
      recentFailures: [],
    });
  });

  it("retains structured failures without resetting the current degradation interval", () => {
    const tracker = new TranscriptHealthTracker();
    tracker.recordFailure({ occurredAt: "2026-01-01T00:00:00Z", failure });
    tracker.recordFailure({ occurredAt: "2026-01-01T00:01:00Z", failure: { ...failure, videoId: "video-456", attempts: 2 } });

    expect(tracker.snapshot()).toMatchObject({
      degraded: true,
      degradedSince: "2026-01-01T00:00:00.000Z",
      failureCount: 2,
      recoveryCount: 0,
      firstFailureAt: "2026-01-01T00:00:00.000Z",
      lastFailureAt: "2026-01-01T00:01:00.000Z",
      lastFailure: { ...failure, videoId: "video-456", attempts: 2, occurredAt: "2026-01-01T00:01:00.000Z" },
    });
  });

  it("recovers after a successful external fetch while retaining failure history", () => {
    const tracker = new TranscriptHealthTracker();
    tracker.recordFailure({ occurredAt: "2026-01-01T00:00:00Z", failure });
    tracker.recordSuccess({ occurredAt: "2026-01-01T00:02:00Z" });

    expect(tracker.snapshot()).toEqual({
      degraded: false,
      degradedSince: null,
      failureCount: 1,
      recoveryCount: 1,
      firstFailureAt: "2026-01-01T00:00:00.000Z",
      lastFailureAt: "2026-01-01T00:00:00.000Z",
      lastRecoveryAt: "2026-01-01T00:02:00.000Z",
      lastFailure: { ...failure, occurredAt: "2026-01-01T00:00:00.000Z" },
      recentFailures: [{ ...failure, occurredAt: "2026-01-01T00:00:00.000Z" }],
    });
  });

  it("bounds retained failure history while preserving lifetime totals", () => {
    const tracker = new TranscriptHealthTracker();
    for (let index = 0; index < TRANSCRIPT_HEALTH_HISTORY_LIMIT + 3; index += 1) {
      tracker.recordFailure({
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
        failure: { ...failure, videoId: `video-${index}` },
      });
    }
    const snapshot = tracker.snapshot();
    expect(snapshot.failureCount).toBe(TRANSCRIPT_HEALTH_HISTORY_LIMIT + 3);
    expect(snapshot.recentFailures).toHaveLength(TRANSCRIPT_HEALTH_HISTORY_LIMIT);
    expect(snapshot.recentFailures[0]?.videoId).toBe("video-3");
    expect(snapshot.recentFailures.at(-1)?.videoId).toBe(`video-${TRANSCRIPT_HEALTH_HISTORY_LIMIT + 2}`);
    expect(Object.isFrozen(snapshot.recentFailures)).toBe(true);
  });

  it("emits only degraded and recovery transitions with finite event labels", () => {
    const events: unknown[] = [];
    const tracker = new TranscriptHealthTracker({ onEvent: (event) => { events.push(event); throw new Error("observer failure"); } });
    tracker.recordFailure({ occurredAt: "2026-01-01T00:00:00Z", failure });
    tracker.recordFailure({ occurredAt: "2026-01-01T00:01:00Z", failure });
    tracker.recordSuccess({ occurredAt: "2026-01-01T00:02:00Z" });
    tracker.recordSuccess({ occurredAt: "2026-01-01T00:03:00Z" });
    expect(events).toEqual([
      { type: "degraded", occurredAt: "2026-01-01T00:00:00.000Z" },
      { type: "recovered", occurredAt: "2026-01-01T00:02:00.000Z" },
    ]);
    expect(tracker.snapshot().recoveryCount).toBe(1);
  });

  it("applies overlapping observations in completion order", () => {
    const tracker = new TranscriptHealthTracker();
    tracker.recordSuccess({ occurredAt: "2026-01-01T00:02:00Z" });
    tracker.recordFailure({ occurredAt: "2026-01-01T00:01:00Z", failure });
    expect(tracker.snapshot()).toMatchObject({ degraded: true, failureCount: 1, recoveryCount: 0 });
    tracker.recordSuccess({ occurredAt: "2026-01-01T00:03:00Z" });
    expect(tracker.snapshot()).toMatchObject({ degraded: false, failureCount: 1, recoveryCount: 1 });
  });

  it("redacts unsafe diagnostic values and returns frozen snapshots", () => {
    const tracker = new TranscriptHealthTracker();
    tracker.recordFailure({ occurredAt: "2026-01-01T00:00:00Z", failure: {
      ...failure, videoId: "video\nsecret", errorCode: "token=private", syscall: "connect https://user:pass@example.invalid",
    } });
    const snapshot = tracker.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshot.lastFailure).toMatchObject({ videoId: "[REDACTED]", errorCode: "[REDACTED]", syscall: "[REDACTED]" });
    expect(() => { (snapshot as { degraded: boolean }).degraded = false; }).toThrow();
    expect(() => { (snapshot as { failureCount: number }).failureCount = 99; }).toThrow();
    expect(tracker.snapshot()).toMatchObject({ degraded: true, failureCount: 1 });
  });
});
