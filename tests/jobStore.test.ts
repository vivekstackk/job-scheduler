import { JobStore } from "../src/jobStore";

describe("JobStore", () => {
  let store: JobStore;

  beforeEach(() => {
    store = new JobStore();
  });

  it("creates a job with a computed nextRunAt and active status", () => {
    const job = store.create({
      name: "daily-report",
      cronExpression: "0 9 * * *",
      handlerType: "send-report",
    });

    expect(job.id).toBeDefined();
    expect(job.status).toBe("active");
    expect(job.nextRunAt).not.toBeNull();
  });

  it("lists all created jobs", () => {
    store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    store.create({ name: "job-b", cronExpression: "0 10 * * *", handlerType: "b" });

    expect(store.list()).toHaveLength(2);
  });

  it("gets a job by id", () => {
    const created = store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    const found = store.get(created.id);

    expect(found?.name).toBe("job-a");
  });

  it("returns undefined for a missing id", () => {
    expect(store.get("does-not-exist")).toBeUndefined();
  });

  it("updates a job's status", () => {
    const created = store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    const updated = store.update(created.id, { status: "paused" });

    expect(updated?.status).toBe("paused");
  });

  it("deletes a job", () => {
    const created = store.create({ name: "job-a", cronExpression: "0 9 * * *", handlerType: "a" });
    store.delete(created.id);

    expect(store.get(created.id)).toBeUndefined();
  });
});