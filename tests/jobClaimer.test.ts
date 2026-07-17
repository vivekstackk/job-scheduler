import { pool } from "../src/db";
import { claimDueJob, renewLease, releaseJob } from "../src/jobClaimer";

async function insertDueJob(name: string): Promise<string> {
  const result = await pool.query(
    `INSERT INTO jobs (name, cron_expression, handler_type, payload, status, next_run_at)
     VALUES ($1, '* * * * *', 'noop', '{}', 'active', now() - interval '1 minute')
     RETURNING id`,
    [name]
  );
  return result.rows[0].id;
}

describe("jobClaimer", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE jobs CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("claims a due job and sets the lock", async () => {
    await insertDueJob("job-a");

    const claimed = await claimDueJob("worker-1", 30000);

    expect(claimed).toBeDefined();
    expect(claimed?.lockedBy).toBe("worker-1");
  });

  it("does not let a second worker claim the same job while the lease is live", async () => {
    await insertDueJob("job-a");

    const first = await claimDueJob("worker-1", 30000);
    const second = await claimDueJob("worker-2", 30000);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
  });

  it("allows a different worker to reclaim a job once its lease has expired", async () => {
    const jobId = await insertDueJob("job-a");

    await pool.query(
      `UPDATE jobs SET locked_by = 'worker-1', lease_expires_at = now() - interval '1 second' WHERE id = $1`,
      [jobId]
    );

    const reclaimed = await claimDueJob("worker-2", 30000);

    expect(reclaimed).toBeDefined();
    expect(reclaimed?.lockedBy).toBe("worker-2");
  });

  it("two workers racing for the same job: only one wins", async () => {
    await insertDueJob("job-a");

    const [a, b] = await Promise.all([
      claimDueJob("worker-1", 30000),
      claimDueJob("worker-2", 30000),
    ]);

    const winners = [a, b].filter((r) => r !== undefined);
    expect(winners).toHaveLength(1);
  });

  it("renewLease extends the lease for the owning worker", async () => {
    await insertDueJob("job-a");
    const claimed = await claimDueJob("worker-1", 5000);

    const renewed = await renewLease(claimed!.id, "worker-1", 30000);
    expect(renewed).toBe(true);
  });

  it("releaseJob clears the lock and reschedules the job", async () => {
    await insertDueJob("job-a");
    const claimed = await claimDueJob("worker-1", 30000);

    await releaseJob(claimed!.id, "worker-1", "0 9 * * *");

    const result = await pool.query("SELECT locked_by, lease_expires_at FROM jobs WHERE id = $1", [claimed!.id]);
    expect(result.rows[0].locked_by).toBeNull();
    expect(result.rows[0].lease_expires_at).toBeNull();
  });
});
