import { pool } from "../src/db";
import { Worker } from "../src/worker";

async function insertDueJob(name: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO jobs (name, cron_expression, handler_type, payload, status, next_run_at)
     VALUES ($1, '0 9 * * *', 'noop', '{}', 'active', now() - interval '1 minute')
     RETURNING id`,
    [name]
  );
  return result.rows[0].id;
}

describe("Worker", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE jobs CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims a due job, runs the handler, and releases the lock", async () => {
    const jobId = await insertDueJob("job-a");
    let handlerCalled = false;

    const worker = new Worker(async () => {
      handlerCalled = true;
    });

    await worker.tick();

    expect(handlerCalled).toBe(true);

    const result = await pool.query("SELECT locked_by, next_run_at FROM jobs WHERE id = $1", [jobId]);
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].next_run_at).not.toBeNull();
  });

  it("does nothing when no job is due", async () => {
    let handlerCalled = false;

    const worker = new Worker(async () => {
      handlerCalled = true;
    });

    await worker.tick();

    expect(handlerCalled).toBe(false);
  });

  it("releases the lock even if the handler throws on every attempt", async () => {
    const jobId = await insertDueJob("job-a");

    const worker = new Worker(async () => {
      throw new Error("handler always fails");
    });

    await worker.tick();

    const result = await pool.query("SELECT locked_by, status FROM jobs WHERE id = $1", [jobId]);
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].status).toBe("dead_letter");
  });
});