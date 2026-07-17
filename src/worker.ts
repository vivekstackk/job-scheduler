import { randomUUID } from "crypto";
import { claimDueJob, renewLease, releaseJob } from "./jobClaimer";
import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { executeWithRetry, JobHandler } from "./executor";

export interface WorkerOptions {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
}

export class Worker {
  private readonly id: string;
  private readonly jobStore = new JobStore();
  private readonly jobRunStore = new JobRunStore();
  private running = false;

  constructor(
    private readonly handler: JobHandler,
    private readonly options: WorkerOptions = {}
  ) {
    this.id = randomUUID();
  }

  async start(): Promise<void> {
    this.running = true;
    const pollIntervalMs = this.options.pollIntervalMs ?? 2000;

    while (this.running) {
      await this.tick();
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  // One claim attempt. Public and separate from start() so tests can call it directly
  // without running an actual infinite polling loop.
  async tick(): Promise<void> {
    const leaseDurationMs = this.options.leaseDurationMs ?? 30000;
    const claimed = await claimDueJob(this.id, leaseDurationMs);
    if (!claimed) return;

    const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3);

    // Renews the lease periodically while the handler runs, so a job that legitimately
    // takes a long time is not mistaken for a dead worker and reclaimed mid-execution.
    // This is what makes the lease pattern safe under real, variable job durations,
    // unlike a fixed-TTL lock with no renewal.
    const heartbeat = setInterval(() => {
      renewLease(claimed.id, this.id, leaseDurationMs).catch(() => {
        // A failed renewal is not fatal here: if this worker has already been
        // reclaimed, the next releaseJob call below will simply no-op because
        // locked_by no longer matches, which is the correct, safe outcome.
      });
    }, heartbeatIntervalMs);

    try {
      const job = await this.jobStore.get(claimed.id);
      if (job) {
        await executeWithRetry(this.jobStore, this.jobRunStore, job, this.handler);
      }
    } finally {
      clearInterval(heartbeat);
      await releaseJob(claimed.id, this.id, claimed.cronExpression);
    }
  }
}