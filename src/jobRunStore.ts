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
}
