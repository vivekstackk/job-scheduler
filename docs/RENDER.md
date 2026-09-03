# Deploying to Render

The live deployment was created by hand in the Render dashboard, not from
`render.yaml`. Applying the blueprint creates *new* services rather than
reconfiguring existing ones, so this file is the authoritative list of
dashboard settings until the services are recreated from it.

Two shapes work. Shape A is what is deployed today.

| | Shape A — two services | Shape B — one service |
|---|---|---|
| Services | Node web service + static site | Node web service |
| Dashboard served by | Render's static host | the API process |
| Direct dashboard links fixed by | the `/*` → `/index.html` rewrite (and `web/public/_redirects`) | the SPA fallback in `src/server.ts` |
| CORS | needed — set `ALLOWED_ORIGINS` | not needed, same origin |
| `VITE_API_URL` | the API's absolute origin | `/api` |

---

## Shape A, service 1 — `job-scheduler-api` (API + scheduler)

| Setting | Value |
|---|---|
| Type | Web Service |
| Runtime | Node |
| Root directory | *(blank — the repo root)* |
| Build command | `npm ci && npm run build` |
| Start command | `npm start` |
| Health check path | `/health` |

`npm start` runs `node dist/index.js`, which applies pending migrations from
`sql/`, binds `0.0.0.0:$PORT`, and then starts the poll loop in the same
process. Render only routes traffic to a service that binds the injected
`PORT` on `0.0.0.0`; both come from `src/index.ts`.

### Environment variables

| Key | Value | Required |
|---|---|---|
| `DATABASE_URL` | internal connection string of `job-scheduler-db` | yes |
| `API_KEY` | any long random string | recommended |
| `ALLOWED_ORIGINS` | the static site's origin, e.g. `https://jobscheduler-150z.onrender.com` | recommended |
| `RUN_WORKER` | `true` — already the default, set it only to make the intent visible | no |
| `JOB_DURATION_MS` | `2000` | no |
| `WORKER_VERBOSE` | `true` logs every idle poll instead of every 30th | no |
| `SKIP_MIGRATIONS` | `true` to manage the schema separately | no |
| `SERVE_WEB` | `false` to stay API-only even when a dashboard was built | no |

Leaving `ALLOWED_ORIGINS` unset reflects whatever origin asks, which is fine
locally and wrong in production. Leaving `API_KEY` unset makes `POST`, `PUT`
and `DELETE` public — the process says so at boot: `API_KEY is not set — write
endpoints (POST/PUT/DELETE) are unauthenticated.`

`RUN_WORKER=false` is the one setting that reproduces the original bug: the API
stores jobs and nothing ever executes them, so `job_runs` stays empty and the
Runs and Logs pages have nothing to show. Only set it if a dedicated worker
service is running `npm run start:worker` — and Render has no free worker type.

---

## Shape A, service 2 — `job-scheduler-web` (dashboard)

| Setting | Value |
|---|---|
| Type | Static Site |
| Build command | `npm --prefix web ci && npm --prefix web run build` |
| Publish directory | `web/dist` |

Add one rule under **Redirects/Rewrites**:

| Source | Destination | Action |
|---|---|---|
| `/*` | `/index.html` | Rewrite |

The app uses `BrowserRouter`, so nothing exists on disk at `/dashboard/jobs`.
Without the rewrite the static host answers with its own plain-text
`Not Found`, which is exactly what a direct load or a refresh of a dashboard
URL used to return. `web/public/_redirects` carries the same rule and is
copied into `web/dist` by the build, so a site created by hand with no rule
configured is fixed by a redeploy alone.

Rewrite, not Redirect: the URL has to stay as typed for React Router to read it.

### Environment variables

| Key | Value |
|---|---|
| `VITE_API_URL` | the API service's origin, no trailing slash, e.g. `https://job-scheduler-j948.onrender.com` |
| `VITE_API_KEY` | the same string as the API's `API_KEY` |

Vite inlines both at build time, so changing either needs a redeploy of the
site — a restart does nothing. `VITE_API_KEY` ships inside a public bundle and
is therefore not a secret; it stops drive-by writes from anyone who finds the
API URL, nothing more.

---

## Database — `job-scheduler-db`

Postgres, free plan. Give the API the **internal** connection string.

Migrations run at API boot from `sql/*.sql` in filename order and are recorded
in `schema_migrations`, so a redeploy is a no-op. The runner holds a Postgres
advisory lock (`src/migrate.ts`), so several instances booting at once is safe.

Never point `npm test` at this database: the DB-backed suites begin with
`TRUNCATE TABLE jobs CASCADE`.

---

## Order of operations

1. Create the database, wait for it to become available.
2. Create the API service with `DATABASE_URL` and `API_KEY`. Deploy.
3. Create the static site with `VITE_API_URL` (the API's URL) and
   `VITE_API_KEY` (the API's `API_KEY`). Deploy.
4. Set `ALLOWED_ORIGINS` on the API to the site's URL. That restarts it.

---

## Verifying a deploy

Substitute your own hosts: `$API` is the API service, `$SITE` the static site.

Health, and proof that migrations ran:

```bash
curl -s $API/health
```

Expect `{"status":"ok","timestamp":"…"}`. A 502 here means the process never
bound `PORT` — read the deploy log.

Direct dashboard routes. Every one must answer `200` with HTML, from `curl`,
from a URL pasted into a fresh tab, and after pressing reload:

```bash
for p in "" /dashboard /dashboard/jobs /dashboard/runs /dashboard/schedules \
         /dashboard/metrics /dashboard/api /dashboard/logs /dashboard/settings; do
  printf '%s -> ' "$p"; curl -s -o /dev/null -w '%{http_code}\n' "$SITE$p"
done
```

An API miss must stay JSON instead of falling back to the shell:

```bash
curl -s $API/jobs/does-not-exist; curl -s $API/nope
```

Expect a JSON body and a `404` both times, never `<!doctype html>`.

A write needs the key, and says so when it is missing:

```bash
curl -s -X POST $API/jobs -H 'content-type: application/json' -d '{"name":"deploy-check","cronExpression":"*/2 * * * *","handlerType":"noop"}'
```

Expect `401`. Repeat with `-H "x-api-key: $API_KEY"` and expect `201` plus a
`nextRunAt` a couple of minutes out.

The scheduler is the part a healthy service does not prove. Watch the API's log
stream; within one poll interval it prints:

```
Checking for due jobs...
Found 1 due job.
Claiming job: <uuid>
Created run: <uuid> (attempt 1/3, status running)
Executing job: deploy-check (noop)
Job completed successfully: <uuid>
```

Then confirm the run was persisted rather than only logged:

```bash
curl -s "$API/runs?limit=5"
```

Expect a run with `status: "success"` and both `startedAt` and `finishedAt`
set. The same row must appear on `$SITE/dashboard/runs`, and the same events on
`$SITE/dashboard/logs`.

Finally, delete it:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE $API/jobs/<id> -H "x-api-key: $API_KEY"
```

Expect `204`, and `$API/runs` no longer lists its runs — `job_runs.job_id` is
`ON DELETE CASCADE`.

---

## Symptoms and causes

| Symptom | Cause |
|---|---|
| `Not Found` on a refreshed dashboard URL | the static site has no `/*` → `/index.html` rewrite, and was built before `web/public/_redirects` existed |
| Dashboard loads but every panel reads "API connection error" | `VITE_API_URL` wrong or unset **at build time**, or `ALLOWED_ORIGINS` on the API does not list the site's origin |
| Jobs save, `job_runs` stays empty, Logs empty | `RUN_WORKER=false` with no worker service running |
| Writes return `401` | `VITE_API_KEY` differs from the API's `API_KEY`, or the site was not rebuilt after the key changed |
| `502` on every path | the process never bound `0.0.0.0:$PORT` — usually a crash at boot, so read the deploy log |
| Blank page, console shows `Unexpected token '<'` | the browser is holding an old `index.html` and asking for a bundle that no longer exists; hard-reload |
| Deploy log stops after `running migrations` | `DATABASE_URL` points somewhere unreachable |

---

## Shape B — one service

Replace both services with a single Node web service:

| Setting | Value |
|---|---|
| Build command | `npm ci && npm run build && npm --prefix web ci && npm --prefix web run build` |
| Start command | `npm start` |
| Health check path | `/health` |
| `VITE_API_URL` | `/api` |

`src/server.ts` looks for `web/dist/index.html`, serves the static assets when
it finds one, and answers an unmatched `GET` that accepts `text/html` with the
shell. The API is mounted at the root *and* under `/api`, so an `/api` base
keeps the dashboard talking to its own origin — no CORS entry and no absolute
URL to maintain. Paths under `/jobs`, `/runs`, `/health` and `/api` always
return JSON, so a mistyped endpoint is a 404 and never a page.




