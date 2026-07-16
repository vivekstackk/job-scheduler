export type JobStatus = "active" | "paused";

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
