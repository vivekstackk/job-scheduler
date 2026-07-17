import { JobStore } from "../src/jobStore";
import { JobRunStore } from "../src/jobRunStore";
import { executeWithRetry } from "../src/executor";
import { pool } from "../src/db";

describe("executeWithRetry", () => {
  let jobStore: JobStore;
  let jobRunStore: JobRunStore;

  beforeEach(async () => {
    jobStore = new JobStore();
    jobRunStore = new JobRunStore();
    await pool.query("TRUNCATE TABLE job_runs, jobs CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records one successful run when the handler succeeds on the first attempt", async () => {
    const job = await jobStore.create({ name: "a", cronExpression: "0 9 * * *", handlerType: "noop" });

    await executeWithRetry(jobStore, jobRunStore, job, async () => {}, { baseDelayMs: 5 });

    const runs = await jobRunStore.listByJob(job.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");

    const updatedJob = await jobStore.get(job.id);
    expect(updatedJob?.status).toBe("active");
  });

  it("retries and succeeds on the second attempt", async () => {
    const job = await jobStore.create({ name: "a", cronExpression: "0 9 * * *", handlerType: "flaky" });
    let callCount = 0;

    await executeWithRetry(
      jobStore,
      jobRunStore,
      job,
      async () => {
        callCount++;
        if (callCount === 1) throw new Error("temporary failure");
      },
      { baseDelayMs: 5 }
    );

    const runs = await jobRunStore.listByJob(job.id);
    expect(runs).toHaveLength(2);
    expect(runs[0].status).toBe("failed");
    expect(runs[1].status).toBe("success");
  });

  it("marks the job dead_letter after exhausting all attempts", async () => {
    const job = await jobStore.create({ name: "a", cronExpression: "0 9 * * *", handlerType: "always-fails" });

    await executeWithRetry(
      jobStore,
      jobRunStore,
      job,
      async () => {
        throw new Error("permanent failure");
      },
      { maxAttempts: 3, baseDelayMs: 5 }
    );

    const runs = await jobRunStore.listByJob(job.id);
    expect(runs).toHaveLength(3);
    expect(runs.every((r) => r.status === "failed")).toBe(true);

    const updatedJob = await jobStore.get(job.id);
    expect(updatedJob?.status).toBe("dead_letter");
  });
});
