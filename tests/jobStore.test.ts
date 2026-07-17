import { JobStore } from "../src/jobStore";
import { pool } from "../src/db";

describe("JobStore (Postgres)", () => {
  let store: JobStore;

  beforeEach(async () => {
    store = new JobStore();
    await pool.query("TRUNCATE TABLE jobs CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a job with a computed nextRunAt and active status", async () => {
    const job = await store.create({
      name: "daily-report",
      cronExpression: "0 9 * * *",
      handlerType: "send-report",
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("active");
    expect(job.nextRunAt).not.toBeNull();
  });

  it("lists all created jobs", async () => {
    await store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    await store.create({ name: "job-b", cronExpression: "0 10 * * *", handlerType: "b" });

    const jobs = await store.list();
    expect(jobs).toHaveLength(2);
  });

  it("gets a job by id", async () => {
    const created = await store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    const found = await store.get(created.id);

    expect(found?.name).toBe("job-a");
  });

  it("returns undefined for a missing id", async () => {
    const missing = await store.get("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeUndefined();
  });

  it("updates a job's status", async () => {
    const created = await store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    const updated = await store.update(created.id, { status: "paused" });

    expect(updated?.status).toBe("paused");
  });

  it("deletes a job", async () => {
    const created = await store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    await store.delete(created.id);

    const found = await store.get(created.id);
    expect(found).toBeUndefined();
  });
});
