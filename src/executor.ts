import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { Job } from "./types";

export type JobHandler = (job: Job) => Promise<void>;

export interface ExecuteOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /**
   * Where lifecycle lines go. Injected rather than calling console directly so
   * the worker can prefix them with its own id, and so tests stay quiet.
   */
  log?: (message: string) => void;
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
  const log = options.log ?? (() => {});

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // The run row is written before the handler is invoked, not after it
    // succeeds. That is what makes an in-flight attempt visible, and what makes
    // a crashed attempt leave evidence behind instead of vanishing.
    const run = await jobRunStore.start(job.id, attempt);

    log(`Created run: ${run.id} (attempt ${attempt}/${maxAttempts}, status running)`);

    try {
      await handler(job);
      await jobRunStore.complete(run.id, "success");

      log(`Job completed successfully: ${job.name} (run ${run.id})`);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await jobRunStore.complete(run.id, "failed", message);

      // Full stack at error level: the run row keeps the message for the
      // dashboard, the log keeps the stack for whoever has to diagnose it.
      console.error(
        `Job failed: ${job.name} (run ${run.id}, attempt ${attempt}/${maxAttempts}): ` +
          `${error instanceof Error ? (error.stack ?? message) : message}`
      );

      if (attempt < maxAttempts) {
        const wait = backoffDelay(attempt, baseDelayMs);
        log(`Retrying ${job.name} in ${wait}ms (attempt ${attempt + 1}/${maxAttempts})`);
        await sleep(wait);
      } else {
        // All attempts exhausted: stop retrying automatically, flag for manual review.
        await jobStore.update(job.id, { status: "dead_letter" });

        console.error(
          `Job moved to dead_letter after ${maxAttempts} failed attempts: ${job.name}`
        );
      }
    }
  }
}
