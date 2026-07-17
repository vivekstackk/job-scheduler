# Distributed Job Scheduler

A cron-as-a-service backend that runs scheduled jobs reliably across multiple worker
processes, even when a worker crashes mid-job.

## The problem this solves

Running scheduled jobs on one server is trivial. Running them safely across several
worker instances is not, because two failure modes have to be solved at once:

- **Duplicate execution** - two workers claim the same due job at the same time.
- **Silent job death** - a worker claims a job, then crashes before finishing, and
  nothing notices.

A common but unsafe approach to the second problem is a Redis lock with a fixed TTL:
if a job runs longer than the TTL, the lock expires while the job is still alive, a
second worker grabs it, and both are now running the same job. This project avoids
that failure mode entirely by using Postgres row-level locking plus a heartbeat/lease
pattern instead.

## Architecture
    +-----------------+
    |  API (Fastify)  |   create / list / pause jobs, view run history
    +--------+--------+
             |
    +--------v--------+
    |    Postgres     |   jobs table + job_runs table
    |                 |   (source of truth AND the lock)
    +--------+--------+
             |
+--------------+--------------+
|              |              |
+-v-----+   +----v---+   +------v-+
|Worker1|   |Worker2 |   |Worker N|   each polls, claims via
+---+---+   +----+---+   +----+---+   SELECT ... FOR UPDATE SKIP LOCKED
|            |            |
+------------+------------+

Each worker polls Postgres for due jobs and claims one atomically using
`SELECT ... FOR UPDATE SKIP LOCKED`. While a job runs, the worker renews a lease on
it every few seconds. If a worker dies, its lease simply stops being renewed - the
next poll from any surviving worker notices the stale lease and reclaims the job.
There is no separate "reaper" process; the claim query's own WHERE clause is the
reclaim mechanism.

## Tech stack

- TypeScript + Fastify - API layer
- Postgres - job store, execution history, and the distributed lock itself
- Docker Compose - multi-worker orchestration
- Jest - test suite (25 tests across 6 suites)

## Running it locally

```bash
docker compose up -d --scale worker=3
npm test
```

## Proof: a live chaos test

With 3 worker containers running, a due job was inserted directly into Postgres,
and the worker that claimed it was killed mid-execution with `docker kill`:
worker-2  | running job chaos-test-job-2
worker-2 exited with code 137                    <- SIGKILL, mid-job
worker-1  | running job chaos-test-job-2         <- reclaimed automatically
worker-1  | finished job chaos-test-job-2         <- completed exactly once

No manual restart, no reaper process, no special-case recovery code - just the
same claim query that runs on every normal poll.

## Known limitation

This guarantees **at-least-once** execution, not exactly-once-with-resumption. A
reclaimed job re-runs its handler from the start, not from wherever the crashed
worker left off. That's safe for idempotent handlers (e.g. regenerating a report)
but would need an idempotency key for non-idempotent ones (e.g. charging a
payment) - a natural next step, not yet implemented.

## Build history

Built in four phases, each with its own written summary covering what was built,
what broke, and why:

1. Core scheduling - cron parsing, in-memory CRUD, Fastify API
2. Persistence - Postgres, execution history, retry with exponential backoff
3. Distributed locking - `SKIP LOCKED`, heartbeat/lease renewal
4. Orchestration - Docker Compose, multi-worker chaos test (above)
