import { pool } from "./db";
import { computeNextRun } from "./scheduler";

export interface ClaimedJob {
  id: string;
  name: string;
  cronExpression: string;
  handlerType: string;
  payload: Record<string, unknown>;
  lockedBy: string;
  leaseExpiresAt: Date;
}

interface ClaimRow {
  id: string;
  name: string;
  cron_expression: string;
  handler_type: string;
  payload: Record<string, unknown>;
  locked_by: string;
  lease_expires_at: Date;
}

function toClaimedJob(row: ClaimRow): ClaimedJob {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    handlerType: row.handler_type,
    payload: row.payload,
    lockedBy: row.locked_by,
    leaseExpiresAt: row.lease_expires_at,
  };
}

// Atomically claims one due job for the given worker.
//
// SELECT ... FOR UPDATE SKIP LOCKED inside the CTE is what makes this safe under
// concurrency: if two workers run this at the same instant, Postgres guarantees each
// row can only be locked by one of them. The second worker's SELECT simply skips any
// row already locked by the first, instead of blocking or erroring.
//
// A job is eligible if it is due AND either it has never been locked, or its previous
// lease has expired - meaning whichever worker held it before is presumed dead and the
// job is safe to reclaim. There is no separate reaper process: this WHERE clause is the
// reclaim mechanism, checked fresh on every claim attempt.
export async function claimDueJob(workerId: string, leaseDurationMs: number): Promise<ClaimedJob | undefined> {
  const result = await pool.query<ClaimRow>(
    `WITH claimable AS (
       SELECT id FROM jobs
       WHERE status = 'active'
         AND next_run_at <= now()
         AND (locked_by IS NULL OR lease_expires_at < now())
       ORDER BY next_run_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE jobs
     SET locked_by = $1, lease_expires_at = now() + ($2 || ' milliseconds')::interval
     FROM claimable
     WHERE jobs.id = claimable.id
     RETURNING jobs.*`,
    [workerId, leaseDurationMs]
  );

  return result.rows[0] ? toClaimedJob(result.rows[0]) : undefined;
}

// Extends the lease for a job the caller believes it still owns. Only succeeds if
// locked_by still matches this worker - protects against a worker that has already
// been reclaimed by someone else mistakenly renewing a lease it no longer holds.
export async function renewLease(jobId: string, workerId: string, leaseDurationMs: number): Promise<boolean> {
  const result = await pool.query(
    `UPDATE jobs
     SET lease_expires_at = now() + ($1 || ' milliseconds')::interval
     WHERE id = $2 AND locked_by = $3
     RETURNING id`,
    [leaseDurationMs, jobId, workerId]
  );

  return (result.rowCount ?? 0) > 0;
}

// Releases the lock after a run finishes and reschedules next_run_at from the cron
// expression. Only releases if workerId still matches, for the same reason as renewLease.
export async function releaseJob(jobId: string, workerId: string, cronExpression: string): Promise<void> {
  const nextRunAt = computeNextRun(cronExpression);

  await pool.query(
    `UPDATE jobs
     SET locked_by = NULL, lease_expires_at = NULL, next_run_at = $1
     WHERE id = $2 AND locked_by = $3`,
    [nextRunAt, jobId, workerId]
  );
}
