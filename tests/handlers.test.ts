import http from "http";
import { AddressInfo } from "net";

import type { Job } from "../src/types";

/**
 * DB-free. Exercises the real http handler against a real local server, because
 * the thing being tested is what it does with a live socket: a timeout, a 500,
 * an unexpected status.
 *
 * handlers.ts reads JOB_DURATION_MS at module load, so it has to be set before
 * the require below — an `import` would be hoisted above this line.
 */
process.env.JOB_DURATION_MS = "5";

const { jobHandler } = require("../src/handlers") as typeof import("../src/handlers");

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

let server: http.Server;
let base: string;
let received: Received[];

/** Per-test control over what the server does with the next request. */
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString(),
      });

      respond(req, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
});

beforeEach(() => {
  received = [];
  respond = (_req, res) => res.end("ok");
});

/** A job row shaped the way the store would return one. */
function job(payload: Record<string, unknown>, handlerType = "http"): Job {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    name: "test-job",
    cronExpression: "* * * * *",
    handlerType,
    payload,
    status: "active",
    nextRunAt: new Date(),
  };
}

/** Captures the rejection message, which is what lands in job_runs.error. */
async function failure(input: Job): Promise<string> {
  try {
    await jobHandler(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected the handler to throw, but it resolved");
}

describe("http handler", () => {
  it("performs the request and resolves on 2xx", async () => {
    await expect(jobHandler(job({ url: `${base}/tasks` }))).resolves.toBeUndefined();

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("GET");
    expect(received[0].url).toBe("/tasks");
  });

  it("sends the configured method, headers and body", async () => {
    await jobHandler(
      job({
        url: `${base}/hook`,
        method: "POST",
        headers: { "x-token": "abc", "content-type": "application/json" },
        body: '{"id":7}',
      })
    );

    expect(received[0].method).toBe("POST");
    expect(received[0].headers["x-token"]).toBe("abc");
    expect(received[0].body).toBe('{"id":7}');
  });

  // ISSUE 4: a non-2xx has to be recorded as a failure, with enough detail to
  // act on. Before this, the handler ignored the status entirely.
  it("fails on a non-2xx and reports the status and body excerpt", async () => {
    respond = (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream database is down");
    };

    const message = await failure(job({ url: `${base}/tasks` }));

    expect(message).toMatch(/returned 500/);
    expect(message).toMatch(/expected 2xx/);
    expect(message).toMatch(/upstream database is down/);
  });

  it("truncates a huge error body instead of writing it all to job_runs", async () => {
    respond = (_req, res) => {
      res.writeHead(502);
      res.end("x".repeat(20000));
    };

    const message = await failure(job({ url: `${base}/tasks` }));

    expect(message.length).toBeLessThan(700);
  });

  it("treats an explicit expectedStatus as the contract", async () => {
    respond = (_req, res) => {
      res.writeHead(404);
      res.end("gone");
    };

    await expect(
      jobHandler(job({ url: `${base}/probe`, expectedStatus: [404] }))
    ).resolves.toBeUndefined();

    // ...and the inverse: a 200 is a failure when 204 was demanded.
    respond = (_req, res) => res.end("fine");

    expect(await failure(job({ url: `${base}/probe`, expectedStatus: [204] }))).toMatch(
      /expected 204/
    );
  });

  // Without the AbortController a hung endpoint would hold the lease until the
  // heartbeat stopped, which reads as a dead worker rather than a slow request.
  it("aborts a hung request at timeoutMs and says so", async () => {
    respond = () => {
      // Never answers. The socket is closed by the server teardown.
    };

    const message = await failure(job({ url: `${base}/slow`, timeoutMs: 150 }));

    expect(message).toMatch(/timed out after 150ms/);
  });

  it("reports a connection failure distinctly from a timeout", async () => {
    // A port that was bound and then released, so the connection is refused
    // rather than rejected by undici's reserved-port list.
    const spare = http.createServer();
    await new Promise<void>((resolve) => spare.listen(0, "127.0.0.1", resolve));
    const port = (spare.address() as AddressInfo).port;
    await new Promise<void>((resolve) => spare.close(() => resolve()));

    const message = await failure(job({ url: `http://127.0.0.1:${port}/nope` }));

    expect(message).toMatch(/failed:/);
    expect(message).not.toMatch(/timed out/);
    // undici's own message is a bare "fetch failed"; the reason lives on cause,
    // and it is the only part of this that tells anyone what to change.
    expect(message).not.toMatch(/failed: fetch failed/);
    expect(message).toMatch(/ECONNREFUSED/);
  });

  // A row created before validation existed can still have an empty payload.
  // Failing loudly puts the reason in job_runs.error, where the Logs page shows
  // it, instead of the job appearing to succeed while doing nothing.
  it("fails with actionable guidance when payload.url is missing", async () => {
    const message = await failure(job({}));

    expect(message).toMatch(/has handlerType "http" but no payload\.url/);
    expect(message).toMatch(/edit the job and set the URL/);
  });

  it("routes webhook through the same request path", async () => {
    await jobHandler(job({ url: `${base}/notify`, method: "POST" }, "webhook"));

    expect(received[0].url).toBe("/notify");
  });
});

describe("handler dispatch", () => {
  it("runs the noop handler without making a request", async () => {
    await expect(jobHandler(job({}, "noop"))).resolves.toBeUndefined();

    expect(received).toHaveLength(0);
  });

  // Resolving rather than throwing is deliberate: throwing would burn all three
  // retries and dead-letter the job over a deployment gap instead of a failure.
  it("falls back to the simulated handler for an unregistered type", async () => {
    await expect(jobHandler(job({}, "not-registered"))).resolves.toBeUndefined();
  });
});

