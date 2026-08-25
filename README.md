markdown
# Distributed Job Scheduler

A cron-as-a-service backend that runs scheduled jobs reliably across multiple worker
processes, even when a worker crashes mid-job.

## Table of Contents

- [Overview](#overview)
- [The Problem This Solves](#the-problem-this-solves)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Running Tests](#running-tests)
- [Live Chaos Test Proof](#live-chaos-test-proof)
- [Known Limitations](#known-limitations)
- [Development Process](#development-process)
- [License](#license)

## Overview

Running scheduled jobs on one server is trivial. Running them safely across several
worker instances is not, because two failure modes have to be solved at once: two
workers claiming the same job, and a crashed worker's job being stuck forever. This
project solves both using Postgres row-level locking and a heartbeat/lease pattern,
proven with automated tests and a live chaos test against real killed containers.

## The Problem This Solves

- **Duplicate execution** - two workers claim the same due job at the same time.
- **Silent job death** - a worker claims a job, then crashes before finishing, and
  nothing notices.

A common but unsafe approach to the second problem is a Redis lock with a fixed TTL:
if a job runs longer than the TTL, the lock expires while the job is still alive, a
second worker grabs it, and both are now running the same job. This project avoids
that failure mode entirely by using Postgres row-level locking plus a heartbeat/lease
pattern instead of a fixed timeout.

## Architecture
                +-----------------+
                |  API (Fastify)  |  create / list / pause jobs, view run history
                +--------+--------+
                         |
                +--------v--------+
                |    Postgres     |  jobs table + job_runs table
                |                 |  (source of truth AND the lock)
                +--------+--------+
                         |
          +--------------+--------------+
          |              |              |
     +----v----+   +-----v----+   +-----v----+
     | Worker 1|   | Worker 2 |   | Worker N |  each polls, claims via
     +---------+   +----------+   +----------+  SELECT ... FOR UPDATE SKIP LOCKED

Each worker polls Postgres for due jobs and claims one atomically using
`SELECT ... FOR UPDATE SKIP LOCKED`. While a job runs, the worker renews a lease on
it every few seconds. If a worker dies, its lease simply stops being renewed - the
next poll from any surviving worker notices the stale lease and reclaims the job.
There is no separate "reaper" process; the claim query's own WHERE clause is the
reclaim mechanism, re-evaluated on every poll.

## Tech Stack

- **TypeScript + Fastify** - API layer
- **Postgres** - job store, execution history, and the distributed lock itself, via
  raw SQL (no ORM), so every locking query stays fully visible
- **Docker Compose** - multi-worker orchestration
- **Jest** - test suite (25 tests across 6 suites)

## Project Structure

job-scheduler/
├── src/ # Application source: API, scheduler, worker, locking logic
├── tests/ # Jest test suites
├── sql/ # Database schema, applied in numeric order
├── docker-compose.yml # Postgres + worker orchestration
├── Dockerfile # Worker container build
└── .env.example # Required environment variables (placeholder values)


## API Reference

| Method | Endpoint           | Description                            |
|--------|--------------------|----------------------------------------|
| GET    | `/health`          | Health check (returns `{ status: "ok" }`) |
| POST   | `/jobs`            | Create a new job                        |
| GET    | `/jobs`            | List all jobs                           |
| GET    | `/jobs/:id`        | Get a single job by ID                  |
| GET    | `/jobs/:id/runs`   | List run history for a job              |
| PUT    | `/jobs/:id`        | Update a job (status, schedule, etc.)   |
| DELETE | `/jobs/:id`        | Delete a job                            |

## Prerequisites

- Node.js 20+
- Docker Desktop - **required**, not optional. Postgres, the worker containers, and
  the test suite all depend on a running Postgres instance, which only exists
  inside Docker here. `npm test` will fail with connection errors if Docker isn't
  running first.
- npm

## Getting Started

```bash
# 1. Clone the repository
git clone <your-repo-url>
cd job-scheduler

# 2. Configure environment variables
cp .env.example .env
# then edit .env with your own local values

# 3. Install dependencies
npm install

# 4. Start Postgres
docker compose up -d

# 5. Apply the database schema (run each file in sql/ in numeric order)
# macOS / Linux:
docker exec -i job-scheduler-postgres-1 psql -U scheduler -d job_scheduler < sql/001_create_jobs.sql
# Windows PowerShell:
Get-Content sql/001_create_jobs.sql | docker exec -i job-scheduler-postgres-1 psql -U scheduler -d job_scheduler
# repeat for 002_create_job_runs.sql and 003_add_locking_columns.sql

# 6. Run the API in development mode
npm run dev
```

## Running Tests

Tests run against a real Postgres instance, not a mock - so Docker Desktop must be
running, and the `postgres` container must be up, before running the suite:

```bash
docker compose up -d
npm test
```

Test files run sequentially (`--runInBand` in the test script), not in parallel,
because multiple suites share one live database and would otherwise interfere with
each other's setup and teardown.

## Live Chaos Test Proof

With 3 worker containers running, a due job was inserted directly into Postgres,
and the worker that claimed it was killed mid-execution with `docker kill`:

worker-2 | running job chaos-test-job-2
worker-2 exited with code 137 <- SIGKILL, mid-job
worker-1 | running job chaos-test-job-2 <- reclaimed automatically
worker-1 | finished job chaos-test-job-2 <- completed exactly once


No manual restart, no reaper process, no special-case recovery code - just the
same claim query that runs on every normal poll.

## Known Limitations

This guarantees **at-least-once** execution, not exactly-once-with-resumption. A
reclaimed job re-runs its handler from the start, not from wherever the crashed
worker left off. That's safe for idempotent handlers (e.g. regenerating a report)
but would need an idempotency key for non-idempotent ones (e.g. charging a
payment) - a natural next step, not yet implemented.

## Development Process

Built in four phases, each tested and committed before moving to the next:

1. **Core scheduling** - cron parsing, in-memory CRUD, Fastify API
2. **Persistence** - Postgres, execution history, retry with exponential backoff
3. **Distributed locking** - `SKIP LOCKED`, heartbeat/lease renewal
4. **Orchestration** - Docker Compose, multi-worker chaos test (above)

## License

MIT - see [LICENSE](LICENSE) for details.