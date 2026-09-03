import { pool } from "./db";
import { JobRun, JobRunStatus } from "./types";

interface JobRunRow {
  id: string;
  job_id: string;
  attempt: number;
  status: JobRunStatus;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

function toJobRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    jobId: row.job_id,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
  };
}

export class JobRunStore {
  async start(jobId: string, attempt: number): Promise<JobRun> {
    const result = await pool.query<JobRunRow>(
      `INSERT INTO job_runs (job_id, attempt, status)
       VALUES ($1, $2, 'running')
       RETURNING *`,
      [jobId, attempt]
    );
    return toJobRun(result.rows[0]);
  }

  async complete(runId: string, status: JobRunStatus, error?: string): Promise<JobRun> {
    const result = await pool.query<JobRunRow>(
      `UPDATE job_runs
       SET status = $1, finished_at = now(), error = $2
       WHERE id = $3
       RETURNING *`,
      [status, error ?? null, runId]
    );
    return toJobRun(result.rows[0]);
  }

  async listByJob(jobId: string): Promise<JobRun[]> {
    const result = await pool.query<JobRunRow>(
      `SELECT * FROM job_runs WHERE job_id = $1 ORDER BY attempt ASC`,
      [jobId]
    );
    return result.rows.map(toJobRun);
  }

  /**
   * Recent runs across every job, newest first.
   *
   * The dashboard's Runs and Logs pages need history for all jobs at once. They
   * used to build it by fetching /jobs/:id/runs once per job — an N+1 that grew
   * a request per job and, with a failure in any one of them swallowed, could
   * render as "0 runs" while the data existed. One ordered query replaces it.
   */
  async listRecent(limit = 200): Promise<JobRun[]> {
    const result = await pool.query<JobRunRow>(
      `SELECT * FROM job_runs ORDER BY started_at DESC, attempt DESC LIMIT $1`,
      [Math.min(Math.max(limit, 1), 1000)]
    );
    return result.rows.map(toJobRun);
  }

  /**
   * Closes out rows left in 'running' by a worker that died mid-execution.
   *
   * complete() only ever runs in the same process that called start(), so a
   * SIGKILL between the two leaves a row that claims to be running forever,
   * with a null finished_at. The lease expiry lets another worker reclaim the
   * job, and this is called at that moment: the previous attempt is known to be
   * over, so it is recorded as failed rather than left lying.
   *
   * Scoped to one job because that is the one whose lease just expired —
   * a blanket sweep would race with runs that are legitimately in flight
   * elsewhere.
   */
  async failOrphaned(jobId: string, reason: string): Promise<number> {
    const result = await pool.query(
      `UPDATE job_runs
       SET status = 'failed', finished_at = now(), error = $1
       WHERE job_id = $2 AND status = 'running'`,
      [reason, jobId]
    );

    return result.rowCount ?? 0;
  }
}
