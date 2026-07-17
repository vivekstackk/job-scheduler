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
