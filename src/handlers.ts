import { Job } from "./types";
import { JobHandler } from "./executor";

// Jobs carry a handlerType, but nothing used to read it — every job ran the same
// simulated body. This registry gives the column meaning while keeping the
// simulated handler as the fallback, so existing rows keep working unchanged.
type Handler = (job: Job) => Promise<void>;

// The chaos test in the README depends on a job that runs long enough to kill a
// worker mid-execution, which is why the default is deliberately slow. A real
// deployment wants this short, hence the override.
const SIMULATED_DURATION_MS = Number(process.env.JOB_DURATION_MS) || 60000;

async function simulated(job: Job): Promise<void> {
  const worker = process.env.HOSTNAME ?? "local";

  console.log(`[${worker}] running job ${job.name}`);
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_DURATION_MS));
  console.log(`[${worker}] finished job ${job.name}`);
}

async function noop(job: Job): Promise<void> {
  console.log(`[${process.env.HOSTNAME ?? "local"}] no-op job ${job.name}`);
}

const handlers: Record<string, Handler> = {
  simulated,
  noop,
};

/**
 * Dispatches on job.handlerType, falling back to the simulated handler for any
 * type with no registered implementation.
 *
 * Unknown types resolve rather than throw on purpose: throwing would burn all
 * three retries and dead-letter the job over a deployment gap — a handler that
 * exists on some instances and not others — rather than over a real failure.
 */
export const jobHandler: JobHandler = async (job) => {
  const handler = handlers[job.handlerType];

  if (!handler) {
    console.warn(
      `[${process.env.HOSTNAME ?? "local"}] no handler registered for ` +
        `"${job.handlerType}", running simulated handler`
    );

    return simulated(job);
  }

  return handler(job);
};
