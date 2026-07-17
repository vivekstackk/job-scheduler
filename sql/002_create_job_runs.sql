CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  error TEXT
);
