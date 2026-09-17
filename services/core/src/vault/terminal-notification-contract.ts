import type { JobStatus } from "./models";

export const JOB_TERMINAL_NOTIFICATION_SCHEMA = "onclave.job.terminal.v1";
export const JOB_TERMINAL_NOTIFICATION_VERSION = 1;

export type TerminalJobStatus = Extract<JobStatus, JobStatus.COMPLETED | JobStatus.FAILED | JobStatus.CANCELLED>;

export type JobTerminalNotification = {
  schema: typeof JOB_TERMINAL_NOTIFICATION_SCHEMA;
  version: typeof JOB_TERMINAL_NOTIFICATION_VERSION;
  event: "job_terminal";
  job_id: string;
  content_id: string;
  status: TerminalJobStatus;
  started_at?: string;
  finished_at?: string;
  duration_seconds: number | null;
  summary?: string;
  trust: "untrusted_data";
};
