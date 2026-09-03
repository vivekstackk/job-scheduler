import path from "path";
import fs from "fs";

import Fastify, { FastifyInstance, FastifyReply } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";

import { JobStore } from "./jobStore";
import { JobRunStore } from "./jobRunStore";
import { UpdateJobInput } from "./jobStore";
import { registerApiKeyAuth } from "./auth";
import { validateCreateJob, validateUpdateJob } from "./validation";
import { HttpError, asClientError, notFound } from "./errors";

// A comma-separated ALLOWED_ORIGINS locks the API to known frontends. Left
// unset it reflects any origin, which keeps local development and the tests
// working — but means a deployed API should always set it.
function corsOrigin(): true | string[] {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) return true;

  return configured
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Every path prefix that belongs to the API.
 *
 * This list is what keeps the SPA fallback honest: a request to something under
 * one of these is an API call, so a miss is a JSON 404 and never index.html.
 * Returning HTML for a mistyped endpoint is how a client ends up parsing
 * "<!doctype html>" as JSON and reporting a nonsense error.
 */
const API_PREFIXES = ["/jobs", "/runs", "/health", "/api"];

function isApiPath(url: string): boolean {
  const pathname = url.split("?")[0];

  return API_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Whether a URL names a file rather than a client route.
 *
 * The SPA fallback must not answer these with the shell. A page that was built
 * against an older bundle asks for /assets/index-OLDHASH.js; 200 plus HTML makes
 * the module loader die on "Unexpected token '<'", while a 404 says plainly that
 * the asset is gone. React Router paths carry no file extension, so a dot in the
 * last segment is the signal.
 */
function looksLikeFile(url: string): boolean {
  const pathname = url.split("?")[0];
  const last = pathname.split("/").pop() ?? "";

  return last.includes(".");
}

/**
 * Locates the built dashboard.
 *
 * Compiled output runs from dist/, so the same relative walk has to work from
 * both dist/ and src/ — hence the candidate list rather than one fixed path.
 */
function findWebRoot(): string | undefined {
  const explicit = process.env.WEB_DIST_PATH?.trim();

  const candidates = [
    ...(explicit ? [explicit] : []),
    path.resolve(__dirname, "../web/dist"),
    path.resolve(__dirname, "../../web/dist"),
    path.resolve(process.cwd(), "web/dist"),
  ];

  return candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, "index.html"))
  );
}

/**
 * Whether this process should serve the dashboard as well as the API.
 *
 * Default is "if it was built, serve it". That is what makes a single-service
 * deployment work without anyone remembering a flag — the reason direct links
 * like /dashboard/jobs used to 404 in production was precisely that nothing was
 * configured to answer them.
 *
 * Off under NODE_ENV=test so the route tests keep asserting on a pure API,
 * where an unknown GET is a 404 rather than the SPA shell.
 */
function shouldServeWeb(): boolean {
  const override = process.env.SERVE_WEB?.trim().toLowerCase();

  if (override === "false" || override === "0") return false;
  if (override === "true" || override === "1") return true;

  return process.env.NODE_ENV !== "test";
}

function registerWeb(app: FastifyInstance): void {
  if (!shouldServeWeb()) {
    app.log.info("SERVE_WEB is off — this process serves the API only");
    return;
  }

  const root = findWebRoot();

  if (!root) {
    app.log.warn(
      "No built dashboard found (web/dist/index.html missing) — serving the API " +
        "only. Run `npm run web:build` to have this process serve the UI too."
    );

    return;
  }

  const indexHtml = path.join(root, "index.html");

  app.register(fastifyStatic, {
    root,
    // The SPA fallback below handles "/" and every client route, so the plugin
    // only needs to answer real files. Letting it serve index.html implicitly
    // would shadow the fallback and make the two disagree.
    index: false,
    // wildcard:false makes the plugin glob web/dist once at registration and
    // register a route per file, so anything built afterwards 404s until the
    // process restarts — a rebuilt dashboard serves an index.html pointing at a
    // hashed bundle the server then refuses, and the page renders blank. The
    // wildcard route resolves per request instead, and a miss under it still
    // falls through to the not-found handler below, which is what keeps API
    // misses answering JSON.
    wildcard: true,
  });

  app.log.info(`Serving dashboard from ${root}`);

  const sendShell = (reply: FastifyReply) =>
    reply
      .code(200)
      .type("text/html; charset=utf-8")
      .send(fs.createReadStream(indexHtml));

  // The document root is a real resource — index.html on disk — so it answers
  // unconditionally instead of going through the Accept check below. A monitor,
  // a link-preview fetch or a plain `curl https://host/` sends Accept: */* and
  // used to get a JSON 404 at the site root, which reads as an outage.
  //
  // Unknown client routes deliberately still require an HTML Accept: that is
  // what stops a mistyped API path from being answered with a page.
  app.get("/", (_request, reply) => sendShell(reply));

  // Fastify has exactly one not-found handler, so the API/SPA split lives here.
  app.setNotFoundHandler((request, reply) => {
    const isRead = request.method === "GET" || request.method === "HEAD";

    // A write to an unknown path is never a page navigation, and neither is a
    // request from something that does not want HTML back (fetch/XHR/curl).
    const wantsHtml = (request.headers.accept ?? "").includes("text/html");

    if (
      !isRead ||
      isApiPath(request.url) ||
      looksLikeFile(request.url) ||
      !wantsHtml
    ) {
      reply.code(404);

      return reply.send({
        error: `route ${request.method} ${request.url} not found`,
      });
    }

    // A browser asking for a dashboard route: hand back the shell and let
    // React Router resolve the path client-side. 200, not 404 — the URL is
    // valid, it just is not a file on disk.
    return sendShell(reply);
  });
}

/**
 * Every API route, in one function so it can be mounted more than once.
 *
 * `app` here is a plugin scope, not the root instance, which is what lets the
 * same routes answer at both `/jobs` and `/api/jobs` — see buildServer().
 */
function registerApiRoutes(
  app: FastifyInstance,
  store: JobStore,
  runStore: JobRunStore
): void {
  // Health check
  app.get("/health", async () => {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  });

  // Create job
  app.post("/jobs", async (request, reply) => {
    const input = validateCreateJob(request.body);
    const job = await store.create(input);

    request.log.info({ jobId: job.id, name: job.name }, "job created");

    reply.code(201);
    return job;
  });

  // List jobs
  app.get("/jobs", async () => {
    return store.list();
  });

  /**
   * Recent runs across every job, newest first.
   *
   * Added because the dashboard needs cross-job history: it was assembling this
   * from one /jobs/:id/runs request per job, which scaled badly and reported
   * "0 runs" if any single request failed.
   */
  app.get<{ Querystring: { limit?: string } }>("/runs", async (request) => {
    const raw = Number(request.query.limit);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 200;

    return runStore.listRecent(limit);
  });

  // Get single job
  app.get<{ Params: { id: string } }>("/jobs/:id", async (request) => {
    const job = await store.get(request.params.id);
    if (!job) throw notFound();

    return job;
  });

  // Get job runs
  app.get<{ Params: { id: string } }>("/jobs/:id/runs", async (request) => {
    const job = await store.get(request.params.id);
    if (!job) throw notFound();

    return runStore.listByJob(request.params.id);
  });

  // Update job
  app.put<{ Params: { id: string }; Body: UpdateJobInput }>(
    "/jobs/:id",
    async (request) => {
      // Read first: validation needs the current handler type to know whether
      // an incoming payload has to satisfy the http contract, and a 404 should
      // win over a validation error for a job that does not exist.
      const existing = await store.get(request.params.id);
      if (!existing) throw notFound();

      const changes = validateUpdateJob(request.body, existing);
      const job = await store.update(request.params.id, changes);
      if (!job) throw notFound();

      request.log.info(
        { jobId: job.id, changes: Object.keys(changes) },
        "job updated"
      );

      return job;
    }
  );

  // Delete job
  app.delete<{ Params: { id: string } }>("/jobs/:id", async (request, reply) => {
    const deleted = await store.delete(request.params.id);
    if (!deleted) throw notFound();

    request.log.info({ jobId: request.params.id }, "job deleted");

    reply.code(204);
    return null;
  });
}

export function buildServer() {
  const app = Fastify({
    logger: true,
  });

  const store = new JobStore();
  const runStore = new JobRunStore();

  // Allow the deployed frontend to communicate with this API
  app.register(cors, {
    origin: corsOrigin(),
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key"],
  });

  /**
   * Accept an empty body on a request that declares JSON.
   *
   * Fastify's default parser rejects one with a 400 reading "Body cannot be
   * empty when content-type is set to 'application/json'". For a POST that
   * forgot its payload that is fair, if unhelpful. For DELETE it is simply
   * wrong: no route here reads a body on DELETE, so a client that sets a default
   * Content-Type on every request — which the dashboard's own api() helper did —
   * could not delete a job at all. The request never reached the route, so the
   * row stayed and the user got that message.
   *
   * An empty body now arrives at the route as undefined, and the validators
   * already answer a missing-but-required body by naming it ("request body must
   * be a JSON object"). Malformed JSON is still a 400.
   */
  app.removeContentTypeParser("application/json");

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (_request, body, done) => {
      const raw = (typeof body === "string" ? body : body.toString()).trim();

      if (!raw) return done(null, undefined);

      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        // Without an explicit status this surfaces as a 500; the body is part of
        // the request, so a syntax error in it is the caller's to fix.
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;

        done(failure, undefined);
      }
    }
  );

  // Reads stay public; POST/PUT/DELETE require x-api-key once API_KEY is set.
  registerApiKeyAuth(app);

  /**
   * One place where every thrown error becomes a response.
   *
   * The rules: an HttpError is deliberate and its message is safe to show; a
   * Postgres error whose SQLSTATE blames the request becomes the matching 4xx;
   * anything else is a bug, so it is logged with its stack and answered with a
   * generic 500 that leaks nothing.
   */
  app.setErrorHandler((error, request, reply) => {
    const deliberate =
      error instanceof HttpError ? error : asClientError(error);

    if (deliberate) {
      request.log.warn(
        { err: error, url: request.url, method: request.method },
        `rejected request: ${deliberate.message}`
      );

      return reply.code(deliberate.statusCode).send({
        error: deliberate.message,
        ...(deliberate.details && deliberate.details.length > 1
          ? { details: deliberate.details }
          : {}),
      });
    }

    // Fastify's own errors (malformed JSON body, payload too large) already
    // carry a sensible status and a message that describes the request.
    const status = (error as { statusCode?: unknown }).statusCode;

    if (typeof status === "number" && status < 500) {
      request.log.warn({ err: error }, "client error");

      return reply.code(status).send({
        error: error instanceof Error ? error.message : "bad request",
      });
    }

    request.log.error(
      { err: error, url: request.url, method: request.method },
      "unhandled error while serving request"
    );

    return reply.code(500).send({
      error: "internal server error",
      // Correlates the opaque response with the logged stack.
      requestId: request.id,
    });
  });

  // Mounted twice on purpose.
  //
  // At the root for the two-service deployment, where the dashboard is a static
  // site calling https://api-host/jobs directly.
  //
  // And under /api for the single-service shape, where one process serves both
  // the dashboard and the API. web/src/App.tsx uses an "/api" base on localhost
  // so the Vite dev proxy can strip it (see web/vite.config.ts) — without this
  // second mount, that same built bundle served straight off this process asked
  // for /api/jobs and got the not-found handler's JSON 404. Being same-origin
  // also means a single-service deployment needs no VITE_API_URL and no CORS
  // entry.
  app.register((instance, _opts, done) => {
    registerApiRoutes(instance, store, runStore);
    done();
  });

  app.register(
    (instance, _opts, done) => {
      registerApiRoutes(instance, store, runStore);
      done();
    },
    { prefix: "/api" }
  );

  // Registered last so the static plugin and the not-found handler see the API
  // routes above already in place.
  registerWeb(app);

  return app;
}
