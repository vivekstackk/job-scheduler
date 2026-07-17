import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { Job } from "./types";

export type JobHandler = (job: Job) => Promise<void>;

export interface ExecuteOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Exponential backoff: attempt 1 waits baseDelayMs, attempt 2 waits 2x, attempt 3 waits 4x, etc.
function backoffDelay(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * Math.pow(2, attempt - 1);
}

export async function executeWithRetry(
  jobStore: JobStore,
  jobRunStore: JobRunStore,
  job: Job,
  handler: JobHandler,
  options: ExecuteOptions = {}
): Promise<void> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const run = await jobRunStore.start(job.id, attempt);

    try {
      await handler(job);
      await jobRunStore.complete(run.id, "success");
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await jobRunStore.complete(run.id, "failed", message);

      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt, baseDelayMs));
      } else {
        // All attempts exhausted: stop retrying automatically, flag for manual review.
        await jobStore.update(job.id, { status: "dead_letter" });
      }
    }
  }
}
