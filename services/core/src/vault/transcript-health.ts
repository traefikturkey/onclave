/** Safe, structured details for one exhausted transcript fetch. */
export type TranscriptFailureDetails = Readonly<{
  videoId: string;
  stage?: string;
  classification?: string;
  attempts?: number;
  httpStatus?: number;
  errorName?: string;
  errorCode?: string;
  errno?: number | string;
  syscall?: string;
}>;

export type TranscriptFailureObservation = Readonly<{
  occurredAt: string | Date;
  failure: TranscriptFailureDetails;
}>;

export type TranscriptSuccessObservation = Readonly<{
  occurredAt: string | Date;
}>;

export const TRANSCRIPT_HEALTH_HISTORY_LIMIT = 10;

export type TranscriptIncident = Readonly<TranscriptFailureDetails & { occurredAt: string }>;

export type TranscriptHealthEvent = Readonly<{
  type: "degraded" | "recovered";
  occurredAt: string;
}>;

export type TranscriptHealthTrackerOptions = Readonly<{
  onEvent?: (event: TranscriptHealthEvent) => void;
}>;

export type TranscriptHealthSnapshot = Readonly<{
  degraded: boolean;
  degradedSince: string | null;
  failureCount: number;
  recoveryCount: number;
  firstFailureAt: string | null;
  lastFailureAt: string | null;
  lastRecoveryAt: string | null;
  lastFailure: TranscriptIncident | null;
  recentFailures: readonly TranscriptIncident[];
}>;

function timestamp(value: string | Date): string {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("transcript health observation has an invalid timestamp");
  return date.toISOString();
}

function safeToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.slice(0, 100);
  return /^[A-Za-z0-9_.-]+$/.test(token) ? token : "[REDACTED]";
}

/** Whitelist and bound diagnostics before they reach health output or structured logs. */
export function safeTranscriptFailure(failure: TranscriptFailureDetails): TranscriptFailureDetails {
  const videoId = /^[A-Za-z0-9_-]{1,64}$/.test(failure.videoId) ? failure.videoId : "[REDACTED]";
  return Object.freeze({
    videoId,
    ...(safeToken(failure.stage) === undefined ? {} : { stage: safeToken(failure.stage) }),
    ...(safeToken(failure.classification) === undefined ? {} : { classification: safeToken(failure.classification) }),
    ...(Number.isSafeInteger(failure.attempts) && (failure.attempts ?? 0) >= 0 ? { attempts: failure.attempts } : {}),
    ...(Number.isInteger(failure.httpStatus) && (failure.httpStatus ?? 0) >= 100 && (failure.httpStatus ?? 0) <= 599 ? { httpStatus: failure.httpStatus } : {}),
    ...(safeToken(failure.errorName) === undefined ? {} : { errorName: safeToken(failure.errorName) }),
    ...(safeToken(failure.errorCode) === undefined ? {} : { errorCode: safeToken(failure.errorCode) }),
    ...(typeof failure.errno === "number" && Number.isSafeInteger(failure.errno)
      ? { errno: failure.errno }
      : typeof failure.errno === "string" && /^[A-Za-z0-9_.-]{1,100}$/.test(failure.errno) ? { errno: failure.errno } : {}),
    ...(safeToken(failure.syscall) === undefined ? {} : { syscall: safeToken(failure.syscall) }),
  });
}

/**
 * In-memory transcript dependency health. Observations are applied in completion order:
 * each call immediately becomes the newest known state, regardless of request start time.
 * Failures preserve the current degradation interval; successful external fetches clear it.
 */
export class TranscriptHealthTracker {
  private degraded = false;
  private readonly onEvent: TranscriptHealthTrackerOptions["onEvent"];
  private readonly recentFailures: TranscriptIncident[] = [];
  private degradedSince: string | null = null;
  private failureCount = 0;
  private recoveryCount = 0;
  private firstFailureAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastRecoveryAt: string | null = null;
  private lastFailure: TranscriptIncident | null = null;

  constructor(options: TranscriptHealthTrackerOptions = {}) {
    this.onEvent = options.onEvent;
  }

  private notify(event: TranscriptHealthEvent): void {
    try {
      this.onEvent?.(Object.freeze(event));
    } catch {
      // Health observers must not affect dependency state transitions.
    }
  }

  recordFailure(observation: TranscriptFailureObservation): void {
    const occurredAt = timestamp(observation.occurredAt);
    const enteredDegraded = !this.degraded;
    if (enteredDegraded) this.degradedSince = occurredAt;
    this.degraded = true;
    this.failureCount += 1;
    this.firstFailureAt ??= occurredAt;
    this.lastFailureAt = occurredAt;
    this.lastFailure = Object.freeze({ ...safeTranscriptFailure(observation.failure), occurredAt });
    this.recentFailures.push(this.lastFailure);
    if (this.recentFailures.length > TRANSCRIPT_HEALTH_HISTORY_LIMIT) this.recentFailures.shift();
    if (enteredDegraded) this.notify({ type: "degraded", occurredAt });
  }

  recordSuccess(observation: TranscriptSuccessObservation): void {
    const occurredAt = timestamp(observation.occurredAt);
    if (!this.degraded) return;
    this.degraded = false;
    this.degradedSince = null;
    this.recoveryCount += 1;
    this.lastRecoveryAt = occurredAt;
    this.notify({ type: "recovered", occurredAt });
  }

  snapshot(): TranscriptHealthSnapshot {
    return Object.freeze({
      degraded: this.degraded,
      degradedSince: this.degradedSince,
      failureCount: this.failureCount,
      recoveryCount: this.recoveryCount,
      firstFailureAt: this.firstFailureAt,
      lastFailureAt: this.lastFailureAt,
      lastRecoveryAt: this.lastRecoveryAt,
      lastFailure: this.lastFailure,
      recentFailures: Object.freeze([...this.recentFailures]),
    });
  }
}
