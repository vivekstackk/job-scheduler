import { pool } from "./db";
import { Job, CreateJobInput, JobStatus } from "./types";
import { computeNextRun } from "./scheduler";

export type UpdateJobInput = Partial<{
  name: string;
  cronExpression: string;
  handlerType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
}>;

interface JobRow {
  id: string;
  name: string;
  cron_expression: string;
  handler_type: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  next_run_at: Date | null;
}

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    name: row.name,
    cronExpression: row.cron_expression,
    handlerType: row.handler_type,
    payload: row.payload,
    status: row.status,
    nextRunAt: row.next_run_at,
  };
}

// Postgres error code 22P02 = invalid input syntax, e.g. a malformed UUID.
// A badly formed id should read as "not found," not crash the request.
function isInvalidUuidError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: string }).code === "22P02"
  );
}

export class JobStore {
  async create(input: CreateJobInput): Promise<Job> {
    const nextRunAt = computeNextRun(input.cronExpression);

    const result = await pool.query<JobRow>(
      `INSERT INTO jobs (name, cron_expression, handler_type, payload, status, next_run_at)
       VALUES ($1, $2, $3, $4, 'active', $5)
       RETURNING *`,
      [input.name, input.cronExpression, input.handlerType, input.payload ?? {}, nextRunAt]
    );

    return toJob(result.rows[0]);
  }

  async list(): Promise<Job[]> {
    const result = await pool.query<JobRow>(`SELECT * FROM jobs ORDER BY created_at ASC`);
    return result.rows.map(toJob);
  }

  async get(id: string): Promise<Job | undefined> {
    try {
      const result = await pool.query<JobRow>(`SELECT * FROM jobs WHERE id = $1`, [id]);
      return result.rows[0] ? toJob(result.rows[0]) : undefined;
    } catch (error) {
      if (isInvalidUuidError(error)) return undefined;
      throw error;
    }
  }

  async update(id: string, changes: UpdateJobInput): Promise<Job | undefined> {
    const existing = await this.get(id);
    if (!existing) return undefined;

    const nextRunAt = changes.cronExpression
      ? computeNextRun(changes.cronExpression)
      : existing.nextRunAt;

    const result = await pool.query<JobRow>(
      `UPDATE jobs
       SET name = $1, cron_expression = $2, handler_type = $3, payload = $4, status = $5, next_run_at = $6
       WHERE id = $7
       RETURNING *`,
      [
        changes.name ?? existing.name,
        changes.cronExpression ?? existing.cronExpression,
        changes.handlerType ?? existing.handlerType,
        changes.payload ?? existing.payload,
        changes.status ?? existing.status,
        nextRunAt,
        id,
      ]
    );

    return toJob(result.rows[0]);
  }

  async delete(id: string): Promise<boolean> {
    const result = await pool.query(`DELETE FROM jobs WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }
}