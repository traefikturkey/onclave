import type { JobStatus } from "./models";
import type { SummaryCoverage, TranscriptFilteringSummary } from "./transcript-analysis";

export const JOB_TERMINAL_NOTIFICATION_SCHEMA = "onclave.job.terminal.v1";
export const JOB_TERMINAL_NOTIFICATION_VERSION = 1;

export type TerminalJobStatus = Extract<JobStatus, JobStatus.COMPLETED | JobStatus.FAILED | JobStatus.CANCELLED>;

/** The callback carries state needed for a routine report, not the full analysis result. */
export type TerminalSummaryCoverage = Pick<SummaryCoverage, "status" | "generation_method">;
export type TerminalFilteringState = TranscriptFilteringSummary;

export type JobTerminalNotification = {
  schema: typeof JOB_TERMINAL_NOTIFICATION_SCHEMA;
  version: typeof JOB_TERMINAL_NOTIFICATION_VERSION;
  event: "job_terminal";
  job_id: string;
  content_id: string;
  status: TerminalJobStatus;
  title?: string;
  started_at?: string;
  finished_at?: string;
  duration_seconds: number | null;
  summary?: string;
  summary_coverage?: TerminalSummaryCoverage;
  filtering?: TerminalFilteringState;
  trust: "untrusted_data";
};
