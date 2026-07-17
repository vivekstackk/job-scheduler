import { Worker } from "./worker";

// Job duration is deliberately long (60s) so there'\''s a real window to perform a
// manual chaos test: kill this container mid-job and watch another worker reclaim it.
async function simulateWork(jobName: string): Promise<void> {
  console.log(`[${process.env.HOSTNAME}] running job ${jobName}`);
  await new Promise((resolve) => setTimeout(resolve, 60000));
  console.log(`[${process.env.HOSTNAME}] finished job ${jobName}`);
}

const worker = new Worker(
  async (job) => {
    await simulateWork(job.name);
  },
  {
    leaseDurationMs: 15000,
    heartbeatIntervalMs: 5000,
    pollIntervalMs: 2000,
  }
);

worker.start();
console.log(`[${process.env.HOSTNAME}] worker started, polling for due jobs`);
