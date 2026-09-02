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
- [Configuration](#configuration)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [Running Tests](#running-tests)
- [Deployment](#deployment)
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

```
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
```

Each worker polls Postgres for due jobs and claims one atomically using
`SELECT ... FOR UPDATE SKIP LOCKED`. While a job runs, the worker renews a lease on
it every few seconds. If a worker dies, its lease simply stops being renewed - the
next poll from any surviving worker notices the stale lease and reclaims the job.
There is no separate "reaper" process; the claim query's own WHERE clause is the
reclaim mechanism, re-evaluated on every poll.

The API and the worker are **separate processes**. Nothing executes a job unless a
worker is running - see [Getting Started](#getting-started) step 6 and
[Deployment](#deployment).

## Tech Stack

- **TypeScript + Fastify** - API layer
- **Postgres** - job store, execution history, and the distributed lock itself, via
  raw SQL (no ORM), so every locking query stays fully visible
- **React + Vite** - dashboard and landing page (`web/`)
- **Docker Compose** - multi-worker orchestration
- **Jest** - test suite (43 tests across 8 suites)
- **GitHub Actions** - typecheck, migrations, tests, and both builds on every push

## Project Structure

```
job-scheduler/
├── src/                  # API, scheduler, worker, locking logic, migration runner
│   ├── index.ts          # API entrypoint (optionally hosts a worker)
│   ├── runWorker.ts      # Dedicated worker entrypoint
│   └── migrate.ts        # Applies sql/ in order, tracked in schema_migrations
├── web/                  # React dashboard + landing page
├── tests/                # Jest test suites
├── sql/                  # Database schema, applied in numeric order
├── .github/workflows/    # CI
├── docker-compose.yml    # Postgres + API + scalable workers
├── Dockerfile            # One image; the command chosen per service decides its role
├── render.yaml           # Render blueprint (API, worker, static site)
└── .env.example          # Every environment variable, documented
```

## API Reference

| Method | Endpoint           | Auth | Description                            |
|--------|--------------------|------|----------------------------------------|
| GET    | `/health`          | -    | Health check (returns `{ status: "ok" }`) |
| POST   | `/jobs`            | key  | Create a new job                        |
| GET    | `/jobs`            | -    | List all jobs                           |
| GET    | `/jobs/:id`        | -    | Get a single job by ID                  |
| GET    | `/jobs/:id/runs`   | -    | List run history for a job              |
| PUT    | `/jobs/:id`        | key  | Update a job (status, schedule, etc.)   |
| DELETE | `/jobs/:id`        | key  | Delete a job                            |

Reads are public; writes need the key. That split exists because the dashboard is a
static site, so any key it holds ships in its bundle and is not a secret - gating
reads on it would buy nothing, while gating writes still stops a passer-by from
deleting every job.

Set `API_KEY` on the API and send it as `x-api-key`:

```bash
curl -X POST http://localhost:3000/jobs \
  -H "Content-Type: application/json" \
  -H "x-api-key: $API_KEY" \
  -d '{"name":"daily-report","cronExpression":"0 9 * * *","handlerType":"simulated"}'
```

With `API_KEY` unset, writes are open and the API logs a warning once at startup.

Cron expressions are 5-field and evaluated in **UTC**.

## Configuration

Copy `.env.example` to `.env` - it documents every variable. The ones that change
behaviour rather than just credentials:

| Variable | Default | Effect |
|----------|---------|--------|
| `API_KEY` | unset | Required as `x-api-key` on writes. Unset leaves writes open. |
| `ALLOWED_ORIGINS` | unset | Comma-separated CORS allowlist. Unset reflects any origin. |
| `RUN_WORKER` | `false` | `true` makes the API process also execute due jobs. |
| `SKIP_MIGRATIONS` | `false` | `true` stops the API applying migrations at boot. |
| `JOB_DURATION_MS` | `60000` | Simulated handler runtime. High by default for the chaos test. |
| `DATABASE_SSL` | auto | `require` / `disable` to override host-based SSL detection. |
| `POLL_INTERVAL_MS` | `2000` | How often a worker looks for due work. |
| `LEASE_DURATION_MS` | `15000` | How long a claim survives without a heartbeat. |
| `HEARTBEAT_INTERVAL_MS` | `5000` | How often a running job renews its lease. |

`DATABASE_SSL` defaults to on for remote hosts and off for local ones, because managed
Postgres requires TLS while a local container rejects it.

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
docker compose up -d postgres

# 5. Apply the database schema
npm run migrate

# 6. Run the API (terminal 1)
npm run dev

# 7. Run a worker (terminal 2) - without this, nothing executes
npm run dev:worker

# 8. (Optional) Run the dashboard & landing page (terminal 3)
npm run web:dev
# then open http://localhost:5173
```

Steps 6 and 7 are separate on purpose: the API only stores jobs, and the worker is
what runs them. If a job's `nextRunAt` keeps passing with no run history appearing,
step 7 is missing. To run both from one process instead, use `RUN_WORKER=true npm run dev`.

`npm run migrate` is idempotent - it records applied files in `schema_migrations` and
takes a Postgres advisory lock, so rerunning it or booting several instances at once
is safe. The API also runs it on startup unless `SKIP_MIGRATIONS=true`.

To bring up the whole stack in Docker instead, including workers:

```bash
docker compose up -d --build --scale worker=3
```

## Running Tests

Most of the suite runs against a real Postgres instance, not a mock - so Docker
Desktop must be running, and the schema must be applied, before running it:

```bash
docker compose up -d postgres
npm run migrate
npm test
```

Test files run sequentially (`--runInBand` in the test script), not in parallel,
because multiple suites share one live database and would otherwise interfere with
each other's setup and teardown.

Two suites are the exception. `tests/auth.test.ts` asserts on rejections that happen in
an `onRequest` hook, before any handler reaches the database, and
`tests/migrate.test.ts` only reads the files in `sql/`. Neither needs Postgres:

```bash
npx jest tests/auth.test.ts tests/migrate.test.ts
```

## Deployment

`render.yaml` is a Render blueprint covering all three pieces: the Postgres database,
the API, and the dashboard as a static site. Applying it creates new services - it does
not reconfigure services already created by hand in the dashboard, so for an existing
deployment copy the settings across instead.

Three things are easy to get wrong on any host:

**A worker has to run.** The image's default command starts the API. On a free plan
that cannot run a second process, set `RUN_WORKER=true` on the API service so it polls
as well as serves. On a paid plan, run `npm run start:worker` as its own service and
leave `RUN_WORKER` off. Skip both and the API will accept jobs, store a correct
`nextRunAt`, and never execute anything: `job_runs` stays empty and the dashboard's
Logs page has nothing to show.

**Static hosting needs a SPA rewrite.** The dashboard uses `BrowserRouter`, so
`/dashboard/logs` has to be served `index.html` rather than looked up as a file.
`web/public/_redirects` handles this on Render and Netlify; `render.yaml` also declares
the rewrite explicitly. Without it, navigating within the app works but refreshing the
page 404s.

**The dashboard's API key is set at build time.** `VITE_API_KEY` is read by Vite during
the build, not at runtime, so changing it means rebuilding the site. It must match the
API's `API_KEY` or writes return 401 - the dashboard reports that as read-only mode
rather than a generic failure. Point the dashboard at its API with `VITE_API_URL`.

Set `ALLOWED_ORIGINS` to the dashboard's URL on any public deployment; unset, the API
reflects whatever origin asks.

## Live Chaos Test Proof

With 3 worker containers running, a due job was inserted directly into Postgres,
and the worker that claimed it was killed mid-execution with `docker kill`:

```
worker-2 | running job chaos-test-job-2
worker-2 exited with code 137        <- SIGKILL, mid-job
worker-1 | running job chaos-test-job-2   <- reclaimed automatically
worker-1 | finished job chaos-test-job-2  <- completed exactly once
```

No manual restart, no reaper process, no special-case recovery code - just the
same claim query that runs on every normal poll.

This depends on the job outlasting the kill, which is why `JOB_DURATION_MS` defaults to
60000. Lower it for anything other than the chaos test.

`SIGTERM` (a `docker stop` or a redeploy) is handled gracefully instead: the worker
stops polling, lets the current job finish, and releases its lease normally. Only
`SIGKILL` exercises the lease-expiry path above.

## Known Limitations

This guarantees **at-least-once** execution, not exactly-once-with-resumption. A
reclaimed job re-runs its handler from the start, not from wherever the crashed
worker left off. That's safe for idempotent handlers (e.g. regenerating a report)
but would need an idempotency key for non-idempotent ones (e.g. charging a
payment) - a natural next step, not yet implemented.

Other known gaps:

- **No "run now".** A dead-lettered job that gets reactivated resumes at its next cron
  occurrence, because the worker already advanced `next_run_at` when it released the
  job. There is no endpoint that moves it earlier.
- **`handlerType` dispatches to a small registry** in `src/handlers.ts`, with the
  simulated handler as the fallback for unknown types. Real handlers go there.
- **The dashboard polls** every 15 seconds by default. There is no websocket or SSE, so
  "live" means one poll interval behind.

## Development Process

Built in four phases, each tested and committed before moving to the next:

1. **Core scheduling** - cron parsing, in-memory CRUD, Fastify API
2. **Persistence** - Postgres, execution history, retry with exponential backoff
3. **Distributed locking** - `SKIP LOCKED`, heartbeat/lease renewal
4. **Orchestration** - Docker Compose, multi-worker chaos test (above)

## License

MIT - see [LICENSE](LICENSE) for details.




