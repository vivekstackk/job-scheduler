export type JobStatus = "active" | "paused" | "dead_letter";

export interface Job {
  id: string;
  name: string;
  cronExpression: string;
  handlerType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  nextRunAt: Date | null;
}

export interface CreateJobInput {
  name: string;
  cronExpression: string;
  handlerType: string;
  payload?: Record<string, unknown>;
}

/**
 * The payload shape the `http` and `webhook` handlers read. Stored in the
 * jobs.payload jsonb column, so it is validated on the way in rather than
 * trusted on the way out — see validation.ts.
 */
export interface HttpJobPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  /** Empty means "any 2xx". Otherwise only these exact codes are a success. */
  expectedStatus: number[];
}

export type JobRunStatus = "running" | "success" | "failed";

export interface JobRun {
  id: string;
  jobId: string;
  attempt: number;
  status: JobRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
}
