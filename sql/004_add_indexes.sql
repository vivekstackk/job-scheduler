-- Indexes for the two queries that run constantly.
--
-- The claim query filters on status and next_run_at and orders by next_run_at,
-- and until now jobs had no index at all beyond its primary key — every poll,
-- from every worker, was a sequential scan of the whole table. Fine at three
-- rows, quadratically wasteful as the table grows.
--
-- Partial on status = 'active' because that is the only status the claim query
-- ever looks for: paused and dead_letter rows stay out of the index entirely,
-- which keeps it small and means the ORDER BY is satisfied by the index order.
CREATE INDEX IF NOT EXISTS jobs_due_idx
  ON jobs (next_run_at)
  WHERE status = 'active';

-- The dashboard reads run history newest-first, both per job and across all
-- jobs. The leading job_id serves the per-job lookup and the ON DELETE CASCADE
-- from job_runs to jobs; started_at DESC serves the ordering.
CREATE INDEX IF NOT EXISTS job_runs_job_started_idx
  ON job_runs (job_id, started_at DESC);

CREATE INDEX IF NOT EXISTS job_runs_started_idx
  ON job_runs (started_at DESC);
