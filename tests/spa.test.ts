import fs from "fs";
import os from "os";
import path from "path";

import { buildServer } from "../src/server";

/**
 * ISSUE 1 — direct loads and refreshes of dashboard routes.
 *
 * DB-free: none of the routes exercised here touch Postgres, and the pool is
 * created lazily, so importing the server never opens a connection.
 *
 * The dashboard is not built during tests, so a temporary dist directory stands
 * in for it via WEB_DIST_PATH. That also keeps the assertions independent of
 * whatever the real bundle happens to contain.
 */

const SHELL = "<!doctype html><html><body><div id=root></div>SPA-SHELL</body></html>";

let root: string;
let app: ReturnType<typeof buildServer>;

const previous = {
  serveWeb: process.env.SERVE_WEB,
  distPath: process.env.WEB_DIST_PATH,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "jobsched-web-"));
  fs.writeFileSync(path.join(root, "index.html"), SHELL);
  fs.mkdirSync(path.join(root, "assets"));
  fs.writeFileSync(path.join(root, "assets", "app.js"), "console.log(1)");

  // shouldServeWeb() is off under NODE_ENV=test so the API route tests keep
  // asserting on a pure API. This suite is the one that wants it on.
  process.env.SERVE_WEB = "true";
  process.env.WEB_DIST_PATH = root;

  app = buildServer();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });

  // process.env is shared across suites in a --runInBand run, so leaving
  // SERVE_WEB on here would change how the other server tests 404.
  if (previous.serveWeb === undefined) delete process.env.SERVE_WEB;
  else process.env.SERVE_WEB = previous.serveWeb;

  if (previous.distPath === undefined) delete process.env.WEB_DIST_PATH;
  else process.env.WEB_DIST_PATH = previous.distPath;
});

/** What a browser navigation looks like. */
const NAVIGATION = { accept: "text/html,application/xhtml+xml,*/*;q=0.8" };

/** What fetch/XHR from the dashboard looks like. */
const XHR = { accept: "application/json" };

// Every route in the sidebar. Each one is a client-side path with no file
// behind it, which is why a direct load used to get the host's "Not Found".
const DASHBOARD_ROUTES = [
  "/dashboard",
  "/dashboard/jobs",
  "/dashboard/runs",
  "/dashboard/schedules",
  "/dashboard/metrics",
  "/dashboard/api",
  "/dashboard/logs",
  "/dashboard/settings",
];

describe("SPA fallback", () => {
  it.each(DASHBOARD_ROUTES)("serves the shell for a direct load of %s", async (url) => {
    const response = await app.inject({ method: "GET", url, headers: NAVIGATION });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.body).toContain("SPA-SHELL");
  });

  it("serves the shell at the root and for the marketing path", async () => {
    for (const url of ["/", "/pricing"]) {
      const response = await app.inject({ method: "GET", url, headers: NAVIGATION });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("SPA-SHELL");
    }
  });

  // The root is a real file, so it must not depend on the Accept header the way
  // an unknown client route does. An uptime monitor, a link-preview fetch and a
  // plain `curl https://host/` all send Accept: */* — answering those with a
  // JSON 404 at the site root reads as an outage.
  it("serves the shell at the root even without an HTML accept header", async () => {
    const wildcard = await app.inject({ method: "GET", url: "/", headers: XHR });

    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.headers["content-type"]).toMatch(/text\/html/);
    expect(wildcard.body).toContain("SPA-SHELL");

    const bare = await app.inject({ method: "GET", url: "/" });
    expect(bare.statusCode).toBe(200);

    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
  });

  it("still serves real files from disk", async () => {
    const response = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("console.log(1)");
  });

  // Files are resolved per request, not globbed once at startup. With a
  // registration-time file list, rebuilding the dashboard under a running
  // server left it serving an index.html that pointed at a hashed bundle the
  // same server then 404'd — the page loaded and rendered nothing at all.
  it("serves an asset that was built after the server started", async () => {
    const built = path.join(root, "assets", "index-afterboot.js");
    fs.writeFileSync(built, "console.log('rebuilt')");

    try {
      const response = await app.inject({
        method: "GET",
        url: "/assets/index-afterboot.js",
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe("console.log('rebuilt')");
    } finally {
      fs.rmSync(built, { force: true });
    }
  });

  // A missing asset is a missing file, not a client route: answering it with the
  // shell is how a stale hashed bundle turns into "Unexpected token '<'".
  it("404s a missing asset instead of serving the shell", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/assets/index-does-not-exist.js",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("SPA-SHELL");
  });

  it("answers HEAD the same way, since a refresh may preflight", async () => {
    const response = await app.inject({
      method: "HEAD",
      url: "/dashboard/runs",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(200);
  });
});

describe("API and SPA stay separated", () => {
  // The explicit instruction in ISSUE 1: do NOT blindly return index.html for
  // missing API routes. A client that parses "<!doctype html>" as JSON reports a
  // nonsense error instead of the 404 that actually happened.
  it.each([
    "/jobs/does-not-exist-at-all/extra",
    "/runs/nope",
    "/health/nope",
    "/api/v9/jobs",
  ])("returns JSON 404 for %s even when the caller wants HTML", async (url) => {
    const response = await app.inject({ method: "GET", url, headers: NAVIGATION });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(response.body).error).toMatch(/not found/);
  });

  it("returns JSON 404 to a fetch for an unknown path", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/dashboard/jobs",
      headers: XHR,
    });

    expect(response.statusCode).toBe(404);
    expect(JSON.parse(response.body).error).toBeDefined();
  });

  it("returns JSON 404 when there is no accept header at all", async () => {
    const response = await app.inject({ method: "GET", url: "/dashboard/jobs" });

    expect(response.statusCode).toBe(404);
  });

  // A write to an unknown path is never a page navigation.
  it.each(["POST", "PUT", "DELETE"])(
    "returns JSON 404 for %s to an unknown path",
    async (method) => {
      const response = await app.inject({
        method: method as "POST",
        url: "/dashboard/jobs",
        headers: NAVIGATION,
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/);
    }
  );

  it("keeps the real API routes answering JSON", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).status).toBe("ok");
  });

  // The root serves the shell on GET/HEAD only; a write there is not a page load.
  it("does not serve the shell for a POST to the root", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  // A query string must not hide an API path from isApiPath().
  it("classifies by pathname, not by the whole URL", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/runs/nope?limit=5",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
  });

  // /jobsomething is not under /jobs, so it is a client route, not an API miss.
  it("does not treat a path that merely starts with an API name as API", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/jobsboard",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SPA-SHELL");
  });

  // This suite is the single-service shape: one process serving the dashboard
  // and the API. That is exactly the shape where the bundle's "/api" base has no
  // Vite proxy in front of it, so /api/health has to answer here — and the SPA
  // fallback must not shadow it with the shell just because a browser asked.
  it("answers the /api-prefixed API instead of the shell", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: NAVIGATION,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.parse(response.body).status).toBe("ok");
  });
});

