import { randomUUID } from "crypto";
import { Job, CreateJobInput, JobStatus } from "./types";
import { computeNextRun } from "./scheduler";

export type UpdateJobInput = Partial<{
  name: string;
  cronExpression: string;
  handlerType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
}>;

export class JobStore {
  private jobs = new Map<string, Job>();

  create(input: CreateJobInput): Job {
    const job: Job = {
      id: randomUUID(),
      name: input.name,
      cronExpression: input.cronExpression,
      handlerType: input.handlerType,
      payload: input.payload ?? {},
      status: "active",
      nextRunAt: computeNextRun(input.cronExpression),
    };

    this.jobs.set(job.id, job);
    return job;
  }

  list(): Job[] {
    return Array.from(this.jobs.values());
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, changes: UpdateJobInput): Job | undefined {
    const existing = this.jobs.get(id);
    if (!existing) return undefined;

    const updated: Job = {
      ...existing,
      ...changes,
      nextRunAt: changes.cronExpression
        ? computeNextRun(changes.cronExpression)
        : existing.nextRunAt,
    };

    this.jobs.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.jobs.delete(id);
  }
}
