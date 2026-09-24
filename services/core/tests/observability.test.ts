import { afterEach, describe, expect, it, vi } from "vitest";
import { createObservability, PROMETHEUS_CONTENT_TYPE } from "../src/observability";
import type { VaultPipelineEvent } from "../src/vault/durability";

function event(values: Omit<VaultPipelineEvent, "occurred_at">): VaultPipelineEvent {
  return { occurred_at: "2026-01-01T00:00:00.000Z", ...values };
}

function metricLine(rendered: string, prefix: string): string {
  const line = rendered.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (line === undefined) throw new Error(`missing metric line: ${prefix}`);
  return line;
}

function captureLogs() {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation((() => true) as typeof process.stderr.write);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation((() => true) as typeof process.stdout.write);
  return { stderr, stdout };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("core observability metrics", () => {
  it("maps every frozen event family to finite counters and duration summaries", () => {
    captureLogs();
    const observability = createObservability();

    observability.sinks.transcriptAttempt({ stage: "watch", attempt: 1, outcome: "success", durationMs: 100 });
    observability.sinks.transcriptAttempt({ stage: "player", attempt: 1, outcome: "retry", classification: "rate_limited", durationMs: 250, httpStatus: 429 });
    observability.sinks.transcriptAttempt({ stage: "captions", attempt: 2, outcome: "failure", classification: "upstream", durationMs: 650, httpStatus: 503 });
    observability.sinks.transcriptHealth({ type: "degraded", occurredAt: "2026-01-01T00:00:00.000Z" });
    observability.sinks.transcriptHealth({ type: "recovered", occurredAt: "2026-01-01T00:01:00.000Z" });

    for (const vaultEvent of [
      event({ event: "job.claimed", job_id: "job-1" }),
      event({ event: "job.started", job_id: "job-1" }),
      event({ event: "job.terminal", job_id: "job-1", outcome: "success" }),
      event({ event: "job.recovery_missing_payload", job_id: "job-2", outcome: "failure", error_code: "JOB_RECOVERY_PAYLOAD_MISSING" }),
      event({ event: "pipeline.stage.started", job_id: "job-1", stage: "llm_call" }),
      event({ event: "pipeline.stage.completed", job_id: "job-1", stage: "llm_call", duration_ms: 2_000 }),
      event({ event: "pipeline.stage.failed", job_id: "job-2", stage: "parse", duration_ms: 1_250, error_code: "PARSE_FAILED" }),
      event({ event: "provider.request.started", job_id: "job-1", stage: "llm_call", provider: "openrouter", model: "ignored-model" }),
      event({ event: "provider.request.completed", job_id: "job-1", stage: "llm_call", provider: "openrouter", model: "ignored-model", duration_ms: 500, outcome: "success" }),
      event({ event: "provider.request.failed", job_id: "job-2", stage: "llm_call", provider: "anthropic", model: "ignored-model", duration_ms: 750, outcome: "failure", error_code: "LLM_CALL_ERROR" }),
      event({ event: "delivery.attempt_started", job_id: "job-1", delivery_kind: "callback", attempt: 1 }),
      event({ event: "delivery.attempt_succeeded", job_id: "job-1", delivery_kind: "callback", attempt: 1, duration_ms: 300, outcome: "success" }),
      event({ event: "delivery.attempt_failed", job_id: "job-2", delivery_kind: "notification", attempt: 2, duration_ms: 400, outcome: "failure", error_code: "DELIVERY_FAILED" }),
    ]) observability.sinks.vault(vaultEvent);

    const rendered = observability.renderMetrics();
    expect(observability.contentType).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(rendered).toContain('onclave_transcript_attempts_total{stage="watch",outcome="success",classification="none"} 1');
    expect(rendered).toContain('onclave_transcript_attempt_duration_seconds_sum{stage="captions",outcome="failure",classification="upstream"} 0.65');
    expect(rendered).toContain('onclave_transcript_attempt_duration_seconds_count{stage="captions",outcome="failure",classification="upstream"} 1');
    expect(rendered).toContain('onclave_transcript_health_transitions_total{state="degraded"} 1');
    expect(rendered).toContain('onclave_transcript_health_transitions_total{state="recovered"} 1');
    expect(rendered).toContain('onclave_vault_job_events_total{event="claimed",outcome="none"} 1');
    expect(rendered).toContain('onclave_vault_job_events_total{event="recovery_missing_payload",outcome="failure"} 1');
    expect(rendered).toContain('onclave_vault_pipeline_stage_events_total{stage="llm_call",status="completed"} 1');
    expect(rendered).toContain('onclave_vault_pipeline_stage_duration_seconds_sum{stage="llm_call",outcome="success"} 2');
    expect(rendered).toContain('onclave_vault_provider_requests_total{provider="openrouter",outcome="started"} 1');
    expect(rendered).toContain('onclave_vault_provider_request_duration_seconds_sum{provider="anthropic",outcome="failure"} 0.75');
    expect(rendered).toContain('onclave_vault_delivery_attempts_total{kind="callback",outcome="success"} 1');
    expect(rendered).toContain('onclave_vault_delivery_attempt_duration_seconds_sum{kind="notification",outcome="failure"} 0.4');
    expect(rendered).not.toContain("ignored-model");
  });

  it("renders the exact Prometheus metric names and types deterministically", () => {
    const observability = createObservability();
    const rendered = observability.renderMetrics();
    const declarations = rendered.split("\n").filter((line) => line.startsWith("# TYPE "));

    expect(declarations).toEqual([
      "# TYPE onclave_transcript_attempts_total counter",
      "# TYPE onclave_transcript_attempt_duration_seconds summary",
      "# TYPE onclave_transcript_health_transitions_total counter",
      "# TYPE onclave_vault_job_events_total counter",
      "# TYPE onclave_vault_pipeline_stage_events_total counter",
      "# TYPE onclave_vault_pipeline_stage_duration_seconds summary",
      "# TYPE onclave_vault_provider_requests_total counter",
      "# TYPE onclave_vault_provider_request_duration_seconds summary",
      "# TYPE onclave_vault_delivery_attempts_total counter",
      "# TYPE onclave_vault_delivery_attempt_duration_seconds summary",
    ]);
    expect(observability.renderMetrics()).toBe(rendered);
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("aggregates repeated counter and duration observations", () => {
    const observability = createObservability();
    observability.sinks.vault(event({ event: "pipeline.stage.completed", stage: "persist", duration_ms: 250 }));
    observability.sinks.vault(event({ event: "pipeline.stage.completed", stage: "persist", duration_ms: 750 }));

    const rendered = observability.renderMetrics();
    expect(metricLine(rendered, 'onclave_vault_pipeline_stage_events_total{stage="persist",status="completed"}')).toBe(
      'onclave_vault_pipeline_stage_events_total{stage="persist",status="completed"} 2',
    );
    expect(metricLine(rendered, 'onclave_vault_pipeline_stage_duration_seconds_count{stage="persist",outcome="success"}')).toBe(
      'onclave_vault_pipeline_stage_duration_seconds_count{stage="persist",outcome="success"} 2',
    );
    expect(metricLine(rendered, 'onclave_vault_pipeline_stage_duration_seconds_sum{stage="persist",outcome="success"}')).toBe(
      'onclave_vault_pipeline_stage_duration_seconds_sum{stage="persist",outcome="success"} 1',
    );
  });

  it("maps unsupported runtime label values to a finite unknown label and ignores unsupported events", () => {
    captureLogs();
    const observability = createObservability();
    observability.sinks.transcriptAttempt({
      stage: "https://secret.example/watch",
      attempt: -1,
      outcome: "credential-value",
      classification: "signature-value",
      durationMs: Number.NaN,
      httpStatus: 999,
    } as never);
    observability.sinks.vault(event({
      event: "provider.request.failed",
      provider: "https://user:password@example.invalid/private",
      duration_ms: Number.POSITIVE_INFINITY,
      error_code: "token=secret",
    } as never));
    observability.sinks.vault(event({ event: "unsupported.event" } as never));

    const rendered = observability.renderMetrics();
    expect(rendered).toContain('onclave_transcript_attempts_total{stage="unknown",outcome="unknown",classification="unknown"} 1');
    expect(rendered).toContain('onclave_vault_provider_requests_total{provider="unknown",outcome="failure"} 1');
    expect(rendered).not.toContain("secret.example");
    expect(rendered).not.toContain("credential-value");
    expect(rendered).not.toContain("signature-value");
    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("unsupported.event");
    expect(rendered).not.toContain("_duration_seconds_count{stage=\"unknown\"");
  });
});

describe("core observability failure logs", () => {
  it("logs only allowlisted pipeline failure fields and keeps safe identifiers and error codes", () => {
    const { stderr } = captureLogs();
    const observability = createObservability();
    const secret = "never-print-this-signature";
    observability.sinks.vault({
      ...event({
        event: "provider.request.failed",
        job_id: "job:01.safe-id",
        stage: "llm_call",
        provider: "openrouter",
        model: "https://model.example/private",
        duration_ms: 125,
        outcome: "failure",
        error_code: "LLM_CALL_ERROR",
      }),
      body: `upstream body ${secret}`,
      signature: secret,
      callback_url: "https://user:password@example.invalid/hook",
      error: new Error(`failed at https://example.invalid/?token=${secret}`),
      ts: "attacker timestamp",
      level: "debug",
    } as never);

    expect(stderr).toHaveBeenCalledTimes(1);
    const line = String(stderr.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "error",
      event: "provider.request.failed",
      job_id: "job:01.safe-id",
      stage: "llm_call",
      provider: "openrouter",
      duration_ms: 125,
      error_code: "LLM_CALL_ERROR",
    });
    expect(parsed.ts).toEqual(expect.any(String));
    expect(parsed).not.toHaveProperty("model");
    expect(parsed).not.toHaveProperty("body");
    expect(parsed).not.toHaveProperty("signature");
    expect(parsed).not.toHaveProperty("callback_url");
    expect(parsed).not.toHaveProperty("error");
    expect(line).not.toContain(secret);
    expect(line).not.toContain("example.invalid");
    expect(line).not.toContain("password");
    expect(line).not.toContain("attacker timestamp");
  });

  it("contains logger exceptions and still records the event", () => {
    vi.spyOn(process.stderr, "write").mockImplementation((() => { throw new Error("logger unavailable"); }) as typeof process.stderr.write);
    const observability = createObservability();

    expect(() => observability.sinks.vault(event({
      event: "delivery.attempt_failed",
      job_id: "job-1",
      delivery_kind: "callback",
      attempt: 1,
      duration_ms: 25,
      outcome: "failure",
      error_code: "DELIVERY_FAILED",
    }))).not.toThrow();
    expect(() => observability.sinks.transcriptAttempt({
      stage: "watch", attempt: 1, outcome: "failure", classification: "network", durationMs: 10,
    })).not.toThrow();

    const rendered = observability.renderMetrics();
    expect(rendered).toContain('onclave_vault_delivery_attempts_total{kind="callback",outcome="failure"} 1');
    expect(rendered).toContain('onclave_transcript_attempts_total{stage="watch",outcome="failure",classification="network"} 1');
  });
});
