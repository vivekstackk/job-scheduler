import { buildServer } from "./server";
import { runMigrations } from "./migrate";
import { Worker } from "./worker";
import { jobHandler } from "./handlers";

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

// One service on a free plan cannot run two processes, so the API can host a
// worker alongside itself. Without this the deployed API accepts jobs, stores
// them with a correct next_run_at, and never executes any of them.
//
// Compose and any multi-instance deployment should instead run runWorker.ts as
// its own process — the claim query is what makes either shape safe.
function startWorkerIfRequested(): void {
  if (process.env.RUN_WORKER !== "true") {
    console.log(
      "RUN_WORKER is not 'true' — this process serves the API only. " +
        "Run `npm run start:worker` separately, or no jobs will execute."
    );

    return;
  }

  const worker = new Worker(jobHandler, {
    leaseDurationMs: Number(process.env.LEASE_DURATION_MS) || 15000,
    heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 5000,
    pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 2000,
  });

  worker.start().catch((error: Error) => {
    // The API stays up: a dead worker loop should not take the whole service
    // with it, and another instance's claim query will pick the work up.
    console.error(`in-process worker crashed: ${error.message}`);
  });

  console.log("In-process worker started, polling for due jobs");
}

async function main(): Promise<void> {
  await migrate();

  const app = buildServer();

  await app.listen({ port, host });
  console.log(`Job scheduler API running at http://${host}:${port}`);

  startWorkerIfRequested();
}

main().catch((error: Error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exit(1);
});
