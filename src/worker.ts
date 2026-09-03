import { randomUUID } from "crypto";
import { claimDueJob, renewLease, releaseJob } from "./jobClaimer";
import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { executeWithRetry, JobHandler } from "./executor";

export interface WorkerOptions {
  pollIntervalMs?: number;
  leaseDurationMs?: number;
  heartbeatIntervalMs?: number;
  /** Logs every poll, not just the ones that find work. Noisy by design. */
  verbose?: boolean;
}

/** Logged every N idle polls so production logs prove the loop is still alive. */
const IDLE_LOG_EVERY = 30;

export class Worker {
  private readonly id: string;
  private readonly jobStore = new JobStore();
  private readonly jobRunStore = new JobRunStore();
  private running = false;
  private idleTicks = 0;
  private consecutiveErrors = 0;

  constructor(
    private readonly handler: JobHandler,
    private readonly options: WorkerOptions = {}
  ) {
    this.id = randomUUID();
  }

  /** Short, stable prefix so interleaved worker output stays readable. */
  private get tag(): string {
    return `[worker ${this.id.slice(0, 8)}]`;
  }

  private log(message: string): void {
    console.log(`${this.tag} ${message}`);
  }

  async start(): Promise<void> {
    this.running = true;
    const pollIntervalMs = this.options.pollIntervalMs ?? 2000;

    this.log(
      `Scheduler starting... (poll ${pollIntervalMs}ms, lease ` +
        `${this.options.leaseDurationMs ?? 30000}ms, id ${this.id})`
    );

    // A tick that throws used to reject start(), which ended the poll loop for
    // the life of the process — one transient connection error and the service
    // kept serving the API while silently never running another job again.
    // Errors are now contained per tick and the loop continues.
    this.log("Scheduler started successfully.");

    while (this.running) {
      try {
        await this.tick();
        this.consecutiveErrors = 0;
      } catch (error) {
        this.consecutiveErrors += 1;
        this.logTickFailure(error);
      }

      await new Promise((resolve) => setTimeout(resolve, this.delay(pollIntervalMs)));
    }

    this.log("Scheduler stopped.");
  }

  /**
   * Backs off on repeated failures so a database that is down does not produce
   * a poll-rate stream of identical errors, then returns to the normal cadence
   * as soon as a tick succeeds. Capped so recovery is never more than 30s away.
   */
  private delay(pollIntervalMs: number): number {
    if (this.consecutiveErrors === 0) return pollIntervalMs;

    const backoff = pollIntervalMs * Math.pow(2, Math.min(this.consecutiveErrors, 5));
    return Math.min(backoff, 30000);
  }

  private logTickFailure(error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);

    console.error(
      `${this.tag} tick failed (${this.consecutiveErrors} in a row), ` +
        `will retry: ${detail}`
    );
  }

  stop(): void {
    this.running = false;
  }

  // One claim attempt. Public and separate from start() so tests can call it directly
  // without running an actual infinite polling loop.
  async tick(): Promise<void> {
    const leaseDurationMs = this.options.leaseDurationMs ?? 30000;

    if (this.options.verbose) this.log("Checking for due jobs...");

    const claimed = await claimDueJob(this.id, leaseDurationMs);

    if (!claimed) {
      this.idleTicks += 1;

      if (this.options.verbose) {
        this.log("Found 0 due jobs.");
      } else if (this.idleTicks % IDLE_LOG_EVERY === 0) {
        this.log(`Still polling — no due jobs in the last ${IDLE_LOG_EVERY} checks.`);
      }

      return;
    }

    this.idleTicks = 0;
    this.log(`Found 1 due job. Claiming job: ${claimed.id}`);

    const heartbeatIntervalMs =
      this.options.heartbeatIntervalMs ?? Math.floor(leaseDurationMs / 3);

    // Renews the lease periodically while the handler runs, so a job that legitimately
    // takes a long time is not mistaken for a dead worker and reclaimed mid-execution.
    // This is what makes the lease pattern safe under real, variable job durations,
    // unlike a fixed-TTL lock with no renewal.
    const heartbeat = setInterval(() => {
      renewLease(claimed.id, this.id, leaseDurationMs).catch((error: unknown) => {
        // A failed renewal is not fatal here: if this worker has already been
        // reclaimed, the releaseJob call below will simply no-op because
        // locked_by no longer matches, which is the correct, safe outcome.
        // It is still worth seeing, because a run of these explains a job that
        // gets picked up twice.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`${this.tag} lease renewal failed for ${claimed.id}: ${reason}`);
      });
    }, heartbeatIntervalMs);

    try {
      // Any run still marked 'running' for this job belongs to a previous
      // attempt whose worker died — this claim only succeeded because that
      // worker's lease expired. Close those rows out before adding to them, so
      // the Runs page never shows a run that has been "running" since Tuesday.
      const orphaned = await this.jobRunStore.failOrphaned(
        claimed.id,
        "worker stopped reporting in; lease expired and the job was reclaimed"
      );

      if (orphaned > 0) {
        console.warn(
          `${this.tag} closed ${orphaned} orphaned run(s) for ${claimed.id} ` +
            `left behind by a dead worker`
        );
      }

      const job = await this.jobStore.get(claimed.id);

      if (!job) {
        // Deleted between the claim and the read. Nothing to run, and the
        // release below is a no-op against a row that no longer exists.
        this.log(`Job ${claimed.id} disappeared before execution; skipping.`);
        return;
      }

      this.log(`Executing job: ${job.name} (${job.handlerType})`);

      await executeWithRetry(this.jobStore, this.jobRunStore, job, this.handler, {
        log: (message) => this.log(message),
      });
    } finally {
      clearInterval(heartbeat);
      await releaseJob(claimed.id, this.id, claimed.cronExpression);
    }
  }
}
