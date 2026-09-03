import { buildServer } from "../src/server";
import { pool } from "../src/db";

describe("job scheduler API", () => {
  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE jobs CASCADE");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("creates a job via POST /jobs", async () => {
    const app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        name: "daily-report",
        cronExpression: "0 9 * * *",
        handlerType: "noop",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.status).toBe("active");
  });

  it("lists jobs via GET /jobs", async () => {
    const app = buildServer();

    await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
    });

    const response = await app.inject({ method: "GET", url: "/jobs" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body).toHaveLength(1);
  });

  it("returns 404 for a job that does not exist", async () => {
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/jobs/does-not-exist" });

    expect(response.statusCode).toBe(404);
  });

  it("updates a job via PUT /jobs/:id", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
    });
    const job = JSON.parse(created.body);

    const response = await app.inject({
      method: "PUT",
      url: `/jobs/${job.id}`,
      payload: { status: "paused" },
    });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("paused");
  });

  it("deletes a job via DELETE /jobs/:id", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
    });
    const job = JSON.parse(created.body);

    const response = await app.inject({ method: "DELETE", url: `/jobs/${job.id}` });

    expect(response.statusCode).toBe(204);
  });

  it("returns health status via GET /health", async () => {
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/health" });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.timestamp).toBeDefined();
  });

  it("returns run history via GET /jobs/:id/runs", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
    });
    const job = JSON.parse(created.body);

    const response = await app.inject({ method: "GET", url: `/jobs/${job.id}/runs` });
    const body = JSON.parse(response.body);

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it("returns 404 for runs of a non-existent job", async () => {
    const app = buildServer();

    const response = await app.inject({ method: "GET", url: "/jobs/does-not-exist/runs" });

    expect(response.statusCode).toBe(404);
  });

  // ISSUE 5 — bad input must not come back as "Internal Server Error". Each of
  // these used to reach Postgres and surface as a 500 with nothing usable.
  describe("validation errors", () => {
    async function post(payload: unknown) {
      const response = await buildServer().inject({
        method: "POST",
        url: "/jobs",
        payload: payload as Record<string, unknown>,
      });

      return { status: response.statusCode, body: JSON.parse(response.body) };
    }

    it("rejects a handlerType with no registered handler", async () => {
      const { status, body } = await post({
        name: "a",
        cronExpression: "0 9 * * *",
        handlerType: "send-report",
      });

      expect(status).toBe(400);
      expect(body.error).toMatch(/no registered handler/);
      expect(body.error).not.toMatch(/internal server error/i);
    });

    it("rejects an invalid cron expression", async () => {
      const { status, body } = await post({
        name: "a",
        cronExpression: "every tuesday",
        handlerType: "noop",
      });

      expect(status).toBe(400);
      expect(body.error).toMatch(/is not a valid cron/);
    });

    it("rejects an http job with no url and says what is missing", async () => {
      const { status, body } = await post({
        name: "a",
        cronExpression: "0 9 * * *",
        handlerType: "http",
      });

      expect(status).toBe(400);
      expect(body.error).toMatch(/requires a payload containing at least a url/);
    });

    it("lists every problem when there is more than one", async () => {
      const { status, body } = await post({ name: "", cronExpression: "??" });

      expect(status).toBe(400);
      expect(Array.isArray(body.details)).toBe(true);
      expect(body.details.length).toBeGreaterThanOrEqual(3);
    });

    it("rejects a malformed JSON body with a 400, not a 500", async () => {
      const response = await buildServer().inject({
        method: "POST",
        url: "/jobs",
        headers: { "content-type": "application/json" },
        payload: '{"name": "a",}',
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).not.toMatch(/internal/i);
    });

    // A client that sets Content-Type: application/json on every request — which
    // the dashboard's api() helper did — sends that header on a DELETE with no
    // body. Fastify's default parser answers 400 "Body cannot be empty when
    // content-type is set to 'application/json'" before the route runs, so the
    // job was never deleted and the message named nothing the user could act on.
    it("deletes a job sent with a JSON content type and no body", async () => {
      const app = buildServer();

      const created = await app.inject({
        method: "POST",
        url: "/jobs",
        payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
      });
      const job = JSON.parse(created.body);

      const response = await app.inject({
        method: "DELETE",
        url: `/jobs/${job.id}`,
        headers: { "content-type": "application/json" },
      });

      expect(response.statusCode).toBe(204);

      const after = await app.inject({ method: "GET", url: `/jobs/${job.id}` });
      expect(after.statusCode).toBe(404);
    });

    // Tolerating the empty body must not turn a POST that forgot its payload
    // into a 500 or a silent success: validation still owns that answer, and now
    // gives it in terms of the request rather than of the content type.
    it("still rejects a POST whose body is empty, naming the body", async () => {
      const response = await buildServer().inject({
        method: "POST",
        url: "/jobs",
        headers: { "content-type": "application/json" },
        payload: "",
      });

      expect(response.statusCode).toBe(400);
      expect(JSON.parse(response.body).error).toMatch(
        /request body must be a JSON object/
      );
    });

    // 22P02 (invalid text representation) is caused by the request, so a
    // malformed UUID reads as "not found" rather than a server fault.
    it("treats a malformed id as not found rather than a server error", async () => {
      const response = await buildServer().inject({
        method: "GET",
        url: "/jobs/not-a-uuid",
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ISSUE 4 — the dashboard form now collects a request, so the API has to store
  // one and hand it back in the shape the handler reads.
  it("stores a normalised http payload and returns it", async () => {
    const app = buildServer();

    const response = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: {
        name: "refresh-cache",
        cronExpression: "*/5 * * * *",
        handlerType: "http",
        payload: { url: "https://api.example.com/tasks", method: "post" },
      },
    });

    expect(response.statusCode).toBe(201);
    const job = JSON.parse(response.body);

    expect(job.payload).toMatchObject({
      url: "https://api.example.com/tasks",
      method: "POST",
      timeoutMs: 10000,
      headers: {},
      expectedStatus: [],
    });
    expect(job.nextRunAt).not.toBeNull();
  });

  // ISSUE 7 — a job paused on Monday and resumed on Thursday used to keep
  // Monday's next_run_at, so the worker claimed it at once and then fired again
  // for every missed slot. Resuming means "schedule from now".
  describe("pause and resume", () => {
    async function createHourly() {
      const app = buildServer();

      const created = await app.inject({
        method: "POST",
        url: "/jobs",
        payload: { name: "hourly", cronExpression: "0 * * * *", handlerType: "noop" },
      });

      return { app, job: JSON.parse(created.body) };
    }

    it("recomputes next_run_at on resume", async () => {
      const { app, job } = await createHourly();

      const paused = await app.inject({
        method: "PUT",
        url: `/jobs/${job.id}`,
        payload: { status: "paused" },
      });
      expect(JSON.parse(paused.body).status).toBe("paused");

      // Move it into the past so a recompute is observable.
      await pool.query(
        `UPDATE jobs SET next_run_at = now() - interval '2 days' WHERE id = $1`,
        [job.id]
      );

      const resumed = await app.inject({
        method: "PUT",
        url: `/jobs/${job.id}`,
        payload: { status: "active" },
      });
      const body = JSON.parse(resumed.body);

      expect(body.status).toBe("active");
      expect(new Date(body.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    });

    // The inverse guard: recomputing on an unrelated edit would silently push
    // the next fire time out every time someone renamed a job.
    it("leaves next_run_at alone on a rename", async () => {
      const { app, job } = await createHourly();

      const renamed = await app.inject({
        method: "PUT",
        url: `/jobs/${job.id}`,
        payload: { name: "hourly-renamed" },
      });
      const body = JSON.parse(renamed.body);

      expect(body.name).toBe("hourly-renamed");
      expect(new Date(body.nextRunAt).getTime()).toBe(
        new Date(job.nextRunAt).getTime()
      );
    });

    it("recomputes next_run_at when the cron itself changes", async () => {
      const { app, job } = await createHourly();

      const updated = await app.inject({
        method: "PUT",
        url: `/jobs/${job.id}`,
        payload: { cronExpression: "* * * * *" },
      });
      const body = JSON.parse(updated.body);

      expect(body.cronExpression).toBe("* * * * *");
      expect(new Date(body.nextRunAt).getTime()).toBeLessThan(
        new Date(job.nextRunAt).getTime()
      );
    });

    // A 404 has to win over a validation error, or a bad edit of a deleted job
    // reports the wrong problem.
    it("returns 404 before validating the body", async () => {
      const response = await buildServer().inject({
        method: "PUT",
        url: "/jobs/00000000-0000-0000-0000-000000000000",
        payload: { status: "nonsense" },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  // ISSUE 6 — the dashboard was assembling cross-job history from one request
  // per job and reporting "0 runs" whenever any single one failed.
  describe("GET /runs", () => {
    it("returns an empty array rather than 404 when nothing has run", async () => {
      const response = await buildServer().inject({ method: "GET", url: "/runs" });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual([]);
    });

    it("returns runs newest first and honours limit", async () => {
      const app = buildServer();

      const created = await app.inject({
        method: "POST",
        url: "/jobs",
        payload: { name: "a", cronExpression: "* * * * *", handlerType: "noop" },
      });
      const job = JSON.parse(created.body);

      // Written directly: the point here is the read path, not the worker.
      for (const [attempt, offset] of [[1, 3], [2, 2], [3, 1]]) {
        await pool.query(
          `INSERT INTO job_runs (job_id, status, attempt, started_at, finished_at)
           VALUES ($1, 'success', $2, now() - ($3 || ' minutes')::interval, now())`,
          [job.id, attempt, String(offset)]
        );
      }

      const all = await app.inject({ method: "GET", url: "/runs" });
      const runs = JSON.parse(all.body);

      expect(runs).toHaveLength(3);
      expect(runs[0].attempt).toBe(3);
      expect(runs[0].jobId).toBe(job.id);
      // ISSUE 3: every run carries both ends of its window.
      expect(runs[0].startedAt).toBeDefined();
      expect(runs[0].finishedAt).not.toBeNull();

      const capped = await app.inject({ method: "GET", url: "/runs?limit=2" });
      expect(JSON.parse(capped.body)).toHaveLength(2);
    });
  });

  // ISSUE 8 — deleting twice must not look like a server fault, and the run
  // history goes with the job (job_runs.job_id is ON DELETE CASCADE).
  it("returns 404 when deleting a job that is already gone", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "a", cronExpression: "0 9 * * *", handlerType: "noop" },
    });
    const job = JSON.parse(created.body);

    expect((await app.inject({ method: "DELETE", url: `/jobs/${job.id}` })).statusCode).toBe(204);

    const again = await app.inject({ method: "DELETE", url: `/jobs/${job.id}` });
    expect(again.statusCode).toBe(404);
    expect(JSON.parse(again.body).error).toBe("job not found");
  });

  /**
   * The same routes are mounted under /api as well.
   *
   * When one process serves both the dashboard and the API, the bundle asks for
   * /api/jobs — web/src/App.tsx uses that base on localhost so the Vite dev
   * proxy can strip it. A root-only mount answered those with a JSON 404, which
   * looked to the user like a dashboard that could not see its own data.
   *
   * Exercising the whole lifecycle rather than one route: a partial mount would
   * be worse than none, because it would fail only on the paths nobody checked.
   */
  it("serves the identical API under the /api prefix", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/api/jobs",
      payload: { name: "via-prefix", cronExpression: "0 9 * * *", handlerType: "noop" },
    });

    expect(created.statusCode).toBe(201);
    const job = JSON.parse(created.body);
    expect(job.nextRunAt).toBeDefined();

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    expect(JSON.parse((await app.inject({ method: "GET", url: "/api/jobs" })).body)).toHaveLength(1);
    expect(JSON.parse((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).body).name).toBe("via-prefix");
    expect(JSON.parse((await app.inject({ method: "GET", url: `/api/jobs/${job.id}/runs` })).body)).toEqual([]);
    expect((await app.inject({ method: "GET", url: "/api/runs?limit=5" })).statusCode).toBe(200);

    const paused = await app.inject({
      method: "PUT",
      url: `/api/jobs/${job.id}`,
      payload: { status: "paused" },
    });
    expect(JSON.parse(paused.body).status).toBe("paused");

    expect((await app.inject({ method: "DELETE", url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/api/jobs/${job.id}` })).statusCode).toBe(404);
  });

  // Both mounts read the same database, so a job created at the root is visible
  // through the prefix. Two independently-registered plugin scopes sharing one
  // pair of stores is the point; separate state would be a silent split brain.
  it("shows the same data through both mounts", async () => {
    const app = buildServer();

    const created = await app.inject({
      method: "POST",
      url: "/jobs",
      payload: { name: "shared", cronExpression: "0 9 * * *", handlerType: "noop" },
    });
    const job = JSON.parse(created.body);

    const viaPrefix = await app.inject({ method: "GET", url: `/api/jobs/${job.id}` });

    expect(viaPrefix.statusCode).toBe(200);
    expect(JSON.parse(viaPrefix.body)).toEqual(job);
  });

  // /api is in API_PREFIXES, so an unknown path under it is still a JSON 404 —
  // the prefix mount must not turn every /api/* typo into something that looks
  // like a real endpoint.
  it("still 404s unknown paths under /api", async () => {
    const app = buildServer();

    for (const url of ["/api", "/api/nope", "/api/v9/jobs", "/api/jobs/x/y/z"]) {
      const response = await app.inject({ method: "GET", url });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
    }
  });
});
