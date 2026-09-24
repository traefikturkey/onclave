import { log } from "./log";
import type { VaultEventSink, VaultPipelineEvent } from "./vault/durability";
import type { TranscriptHealthEvent } from "./vault/transcript-health";
import type { TranscriptAttemptEvent } from "./vault/youtube-transcript";

export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8" as const;

export type TranscriptAttemptSink = (event: TranscriptAttemptEvent) => void;
export type TranscriptHealthEventSink = (event: TranscriptHealthEvent) => void;

export type ObservabilitySinks = Readonly<{
  vault: VaultEventSink;
  transcriptAttempt: TranscriptAttemptSink;
  transcriptHealth: TranscriptHealthEventSink;
}>;

export type Observability = Readonly<{
  contentType: typeof PROMETHEUS_CONTENT_TYPE;
  sinks: ObservabilitySinks;
  renderMetrics(): string;
}>;

type Labels = Readonly<Record<string, string>>;
type MetricSample = { labels: Labels; value: number };
type SummarySample = { labels: Labels; count: number; sum: number };

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, "\\\"");
}

function renderLabels(names: readonly string[], labels: Labels): string {
  if (names.length === 0) return "";
  return `{${names.map((name) => `${name}="${escapeLabel(labels[name] ?? "unknown")}"`).join(",")}}`;
}

function sampleKey(names: readonly string[], labels: Labels): string {
  return names.map((name) => labels[name] ?? "unknown").join("\u0000");
}

function prometheusNumber(value: number): string {
  return Object.is(value, -0) ? "0" : String(value);
}

class Counter {
  private readonly samples = new Map<string, MetricSample>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {}

  increment(labels: Labels): void {
    const key = sampleKey(this.labelNames, labels);
    const existing = this.samples.get(key);
    if (existing === undefined) this.samples.set(key, { labels, value: 1 });
    else existing.value += 1;
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const [key, sample] of [...this.samples.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      void key;
      lines.push(`${this.name}${renderLabels(this.labelNames, sample.labels)} ${prometheusNumber(sample.value)}`);
    }
    return lines;
  }
}

class Summary {
  private readonly samples = new Map<string, SummarySample>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly labelNames: readonly string[],
  ) {}

  observe(labels: Labels, value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
    const key = sampleKey(this.labelNames, labels);
    const existing = this.samples.get(key);
    if (existing === undefined) this.samples.set(key, { labels, count: 1, sum: value });
    else {
      existing.count += 1;
      existing.sum += value;
    }
  }

  render(): string[] {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} summary`];
    for (const [key, sample] of [...this.samples.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      void key;
      const labels = renderLabels(this.labelNames, sample.labels);
      lines.push(`${this.name}_count${labels} ${prometheusNumber(sample.count)}`);
      lines.push(`${this.name}_sum${labels} ${prometheusNumber(sample.sum)}`);
    }
    return lines;
  }
}

const TRANSCRIPT_STAGES = ["watch", "player", "captions", "request"] as const;
const TRANSCRIPT_OUTCOMES = ["success", "retry", "failure"] as const;
const TRANSCRIPT_CLASSIFICATIONS = ["network", "timeout", "rate_limited", "upstream", "blocked"] as const;
const PIPELINE_STAGES = ["context_fetch", "llm_call", "parse", "chunking", "embedding", "persist"] as const;
const PROVIDERS = ["ollama", "openai", "anthropic", "openrouter", "none", "configured"] as const;
const DELIVERY_KINDS = ["callback", "notification"] as const;

function finiteLabel(value: unknown, allowed: readonly string[]): string {
  return typeof value === "string" && allowed.includes(value) ? value : "unknown";
}

function optionalClassification(value: unknown): string {
  if (value === undefined) return "none";
  return finiteLabel(value, TRANSCRIPT_CLASSIFICATIONS);
}

function durationSeconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1_000 : undefined;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function safeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : undefined;
}

function failureFields(event: VaultPipelineEvent): Record<string, unknown> {
  const jobId = safeIdentifier(event.job_id);
  const stage = finiteLabel(event.stage, PIPELINE_STAGES);
  const provider = finiteLabel(event.provider, PROVIDERS);
  const deliveryKind = finiteLabel(event.delivery_kind, DELIVERY_KINDS);
  const attempt = safeInteger(event.attempt);
  const durationMs = typeof event.duration_ms === "number" && Number.isFinite(event.duration_ms) && event.duration_ms >= 0
    ? event.duration_ms
    : undefined;
  const errorCode = safeErrorCode(event.error_code);
  return {
    ...(jobId === undefined ? {} : { job_id: jobId }),
    ...(event.stage === undefined ? {} : { stage }),
    ...(event.provider === undefined ? {} : { provider }),
    ...(event.delivery_kind === undefined ? {} : { delivery_kind: deliveryKind }),
    ...(attempt === undefined ? {} : { attempt }),
    ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    ...(errorCode === undefined ? {} : { error_code: errorCode }),
  };
}

function safeLog(level: "info" | "warn" | "error", event: string, fields: Record<string, unknown> = {}): void {
  try {
    log(level, event, fields);
  } catch {
    // Observability output must never alter application outcomes.
  }
}

/** Creates isolated in-memory metrics and safe event sinks for one core runtime. */
export function createObservability(): Observability {
  const transcriptAttempts = new Counter(
    "onclave_transcript_attempts_total",
    "Transcript upstream request attempts.",
    ["stage", "outcome", "classification"],
  );
  const transcriptDuration = new Summary(
    "onclave_transcript_attempt_duration_seconds",
    "Transcript upstream request attempt duration in seconds.",
    ["stage", "outcome", "classification"],
  );
  const transcriptHealth = new Counter(
    "onclave_transcript_health_transitions_total",
    "Transcript dependency health transitions.",
    ["state"],
  );
  const jobEvents = new Counter(
    "onclave_vault_job_events_total",
    "Vault pipeline job lifecycle events.",
    ["event", "outcome"],
  );
  const stageEvents = new Counter(
    "onclave_vault_pipeline_stage_events_total",
    "Vault pipeline stage lifecycle events.",
    ["stage", "status"],
  );
  const stageDuration = new Summary(
    "onclave_vault_pipeline_stage_duration_seconds",
    "Vault pipeline stage duration in seconds.",
    ["stage", "outcome"],
  );
  const providerRequests = new Counter(
    "onclave_vault_provider_requests_total",
    "Vault pipeline provider request events.",
    ["provider", "outcome"],
  );
  const providerDuration = new Summary(
    "onclave_vault_provider_request_duration_seconds",
    "Vault pipeline provider request duration in seconds.",
    ["provider", "outcome"],
  );
  const deliveryAttempts = new Counter(
    "onclave_vault_delivery_attempts_total",
    "Vault terminal delivery attempt events.",
    ["kind", "outcome"],
  );
  const deliveryDuration = new Summary(
    "onclave_vault_delivery_attempt_duration_seconds",
    "Vault terminal delivery attempt duration in seconds.",
    ["kind", "outcome"],
  );

  const transcriptAttempt: TranscriptAttemptSink = (event) => {
    try {
      const labels = {
        stage: finiteLabel(event.stage, TRANSCRIPT_STAGES),
        outcome: finiteLabel(event.outcome, TRANSCRIPT_OUTCOMES),
        classification: optionalClassification(event.classification),
      };
      transcriptAttempts.increment(labels);
      transcriptDuration.observe(labels, durationSeconds(event.durationMs));
      if (event.outcome === "failure") {
        const attempt = safeInteger(event.attempt);
        const httpStatus = safeHttpStatus(event.httpStatus);
        safeLog("warn", "transcript.attempt_failed", {
          stage: labels.stage,
          classification: labels.classification,
          ...(attempt === undefined ? {} : { attempt }),
          ...(httpStatus === undefined ? {} : { httpStatus }),
          ...(typeof event.durationMs === "number" && Number.isFinite(event.durationMs) && event.durationMs >= 0
            ? { durationMs: event.durationMs }
            : {}),
        });
      }
    } catch {
      // Metrics and logging must not alter transcript attempt outcomes.
    }
  };

  const transcriptHealthSink: TranscriptHealthEventSink = (event) => {
    try {
      const state = finiteLabel(event.type, ["degraded", "recovered"]);
      transcriptHealth.increment({ state });
      if (event.type === "degraded") safeLog("warn", "transcript.health.degraded");
      else if (event.type === "recovered") safeLog("info", "transcript.health.recovered");
    } catch {
      // Metrics and logging must not alter transcript health transitions.
    }
  };

  const vault: VaultEventSink = (event) => {
    try {
      switch (event.event) {
        case "job.claimed":
          jobEvents.increment({ event: "claimed", outcome: "none" });
          break;
        case "job.started":
          jobEvents.increment({ event: "started", outcome: "none" });
          break;
        case "job.terminal": {
          const outcome = finiteLabel(event.outcome, ["success", "failure"]);
          jobEvents.increment({ event: "terminal", outcome });
          if (event.outcome === "failure") safeLog("error", event.event, failureFields(event));
          break;
        }
        case "job.recovery_missing_payload":
          jobEvents.increment({ event: "recovery_missing_payload", outcome: "failure" });
          safeLog("error", event.event, failureFields(event));
          break;
        case "pipeline.stage.started": {
          const stage = finiteLabel(event.stage, PIPELINE_STAGES);
          stageEvents.increment({ stage, status: "started" });
          break;
        }
        case "pipeline.stage.completed": {
          const stage = finiteLabel(event.stage, PIPELINE_STAGES);
          stageEvents.increment({ stage, status: "completed" });
          stageDuration.observe({ stage, outcome: "success" }, durationSeconds(event.duration_ms));
          break;
        }
        case "pipeline.stage.failed": {
          const stage = finiteLabel(event.stage, PIPELINE_STAGES);
          stageEvents.increment({ stage, status: "failed" });
          stageDuration.observe({ stage, outcome: "failure" }, durationSeconds(event.duration_ms));
          safeLog("error", event.event, failureFields(event));
          break;
        }
        case "provider.request.started": {
          const provider = finiteLabel(event.provider, PROVIDERS);
          providerRequests.increment({ provider, outcome: "started" });
          break;
        }
        case "provider.request.completed": {
          const provider = finiteLabel(event.provider, PROVIDERS);
          providerRequests.increment({ provider, outcome: "success" });
          providerDuration.observe({ provider, outcome: "success" }, durationSeconds(event.duration_ms));
          break;
        }
        case "provider.request.failed": {
          const provider = finiteLabel(event.provider, PROVIDERS);
          providerRequests.increment({ provider, outcome: "failure" });
          providerDuration.observe({ provider, outcome: "failure" }, durationSeconds(event.duration_ms));
          safeLog("error", event.event, failureFields(event));
          break;
        }
        case "delivery.attempt_started": {
          const kind = finiteLabel(event.delivery_kind, DELIVERY_KINDS);
          deliveryAttempts.increment({ kind, outcome: "started" });
          break;
        }
        case "delivery.attempt_succeeded": {
          const kind = finiteLabel(event.delivery_kind, DELIVERY_KINDS);
          deliveryAttempts.increment({ kind, outcome: "success" });
          deliveryDuration.observe({ kind, outcome: "success" }, durationSeconds(event.duration_ms));
          break;
        }
        case "delivery.attempt_failed": {
          const kind = finiteLabel(event.delivery_kind, DELIVERY_KINDS);
          deliveryAttempts.increment({ kind, outcome: "failure" });
          deliveryDuration.observe({ kind, outcome: "failure" }, durationSeconds(event.duration_ms));
          safeLog("warn", event.event, failureFields(event));
          break;
        }
      }
    } catch {
      // Metrics and logging must not alter job, stage, provider, or delivery outcomes.
    }
  };

  const metrics = [
    transcriptAttempts,
    transcriptDuration,
    transcriptHealth,
    jobEvents,
    stageEvents,
    stageDuration,
    providerRequests,
    providerDuration,
    deliveryAttempts,
    deliveryDuration,
  ];
  const sinks = Object.freeze({ vault, transcriptAttempt, transcriptHealth: transcriptHealthSink });

  return Object.freeze({
    contentType: PROMETHEUS_CONTENT_TYPE,
    sinks,
    renderMetrics: (): string => `${metrics.flatMap((metric) => metric.render()).join("\n")}\n`,
  });
}
