import { buildServer } from "./server";
import { runMigrations } from "./migrate";
import { Worker } from "./worker";
import { jobHandler } from "./handlers";
import { pool } from "./db";

const port = Number(process.env.PORT) || 3000;
const host = "0.0.0.0";

// Managed hosts give a free-tier service no shell to run migrations from, so the
// schema is applied at boot instead. runMigrations takes an advisory lock and
// records what it applied, so several instances booting together is safe and a
// restart is a no-op. Set SKIP_MIGRATIONS=true to manage the schema separately.
async function migrate(): Promise<void> {
  if (process.env.SKIP_MIGRATIONS === "true") {
    console.log("SKIP_MIGRATIONS=true — leaving the schema alone");
    return;
  }

  const { applied } = await runMigrations();

  console.log(
    applied.length
      ? `Applied ${applied.length} migration(s): ${applied.join(", ")}`
      : "Schema already up to date"
  );
}

/**
 * Whether this process should also run the scheduler loop.
 *
 * This used to be opt-in behind RUN_WORKER=true, and that was the single reason
 * the deployed service stored jobs and never ran any of them: the service was
 * created by hand, nobody set the variable, startup logged a warning nobody
 * read, and job_runs stayed empty forever.
 *
 * So the default is inverted — a process that serves this API also executes due
 * jobs unless explicitly told not to. RUN_WORKER=false is how a deployment with
 * a dedicated worker service turns it off, and that deployment fails loudly
 * (no jobs run, worker service missing) rather than silently.
 */
function workerEnabled(): boolean {
  const configured = process.env.RUN_WORKER?.trim().toLowerCase();

  if (configured === "false" || configured === "0") return false;

  return true;
}

function startWorker(): Worker | undefined {
  if (!workerEnabled()) {
    console.log(
      "RUN_WORKER=false — this process serves the API only. Run " +
        "`npm run start:worker` as a separate process, or no jobs will execute."
    );

    return undefined;
  }

  const worker = new Worker(jobHandler, {
    leaseDurationMs: Number(process.env.LEASE_DURATION_MS) || 15000,
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 5000,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 2000,
    verbose: process.env.WORKER_VERBOSE === "true",
  });

  // start() contains its own per-tick error handling and does not resolve until
  // stop() is called, so reaching this catch means the loop itself broke.
  worker.start().catch((error: unknown) => {
    const detail =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    // The API stays up: a dead worker loop should not take the whole service
    // with it, and another instance's claim query will pick the work up.
    console.error(`Scheduler loop exited unexpectedly: ${detail}`);
  });

  return worker;
}

/**
 * Lets an in-flight job finish and release its lease before the process goes,
 * instead of leaving the row locked until the lease expires. Render sends
 * SIGTERM on every redeploy, so without this each deploy strands a job for the
 * lease duration.
 */
function installShutdown(app: ReturnType<typeof buildServer>, worker?: Worker): void {
  let shuttingDown = false;

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;

      console.log(`${signal} received — draining`);
      worker?.stop();

      const timeout = setTimeout(() => {
        console.warn("Shutdown timed out; exiting anyway");
        process.exit(0);
      }, 10000);

      app
        .close()
        .then(() => pool.end())
        .catch((error: unknown) => {
          console.error(`Error during shutdown: ${String(error)}`);
        })
        .finally(() => {
          clearTimeout(timeout);
          process.exit(0);
        });
    });
  }
}

async function main(): Promise<void> {
  await migrate();

  const app = buildServer();

  await app.listen({ port, host });
  console.log(`Job scheduler API running at http://${host}:${port}`);

  const worker = startWorker();
  installShutdown(app, worker);
}

main().catch((error: unknown) => {
  const detail =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  console.error(`Startup failed: ${detail}`);
  process.exit(1);
});
