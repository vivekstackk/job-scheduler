import { Worker } from "./worker";
import { jobHandler } from "./handlers";
import { pool } from "./db";

// Dedicated worker entrypoint: `npm run start:worker`, or the command the
// compose worker service runs. The API entrypoint (index.ts) can also host a
// worker in-process via RUN_WORKER=true, which is how a single-service
// deployment gets its jobs executed.
const worker = new Worker(jobHandler, {
  leaseDurationMs: Number(process.env.LEASE_DURATION_MS) || 15000,
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 5000,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 2000,
  verbose: process.env.WORKER_VERBOSE === "true",
});

const name = process.env.HOSTNAME ?? "local";

// start() handles its own per-tick failures and only resolves after stop(), so
// a rejection here means the loop itself broke and this process has stopped
// executing jobs. Exiting non-zero lets the platform restart it.
worker.start().catch((error: unknown) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  console.error(`[${name}] worker crashed: ${detail}`);
  process.exit(1);
});

console.log(`[${name}] worker started, polling for due jobs`);

// SIGTERM is what `docker stop` and a Render redeploy send. Stopping the poll
// loop lets an in-flight job finish and release its lease normally instead of
// leaving the row locked until the lease expires.
//
// SIGKILL is deliberately not handled — that path is the chaos test, and lease
// expiry is what recovers it.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[${name}] ${signal} received, finishing current job`);
    worker.stop();

    // The poll loop checks its flag between ticks, so the process winds down on
    // its own once the current job releases. This only closes the pool behind
    // it; an unresponsive job still gets the runtime's own hard kill.
    setTimeout(() => {
      pool.end().finally(() => process.exit(0));
    }, 1000);
  });
}
