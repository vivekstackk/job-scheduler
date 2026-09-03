import { Job, HttpJobPayload } from "./types";
import { JobHandler } from "./executor";

// Jobs carry a handlerType, but nothing used to read it — every job ran the same
// simulated body. This registry gives the column meaning while keeping the
// simulated handler as the fallback, so existing rows keep working unchanged.
type Handler = (job: Job) => Promise<void>;

// The chaos test in the README depends on a job that runs long enough to kill a
// worker mid-execution, which is why the default is deliberately slow. A real
// deployment wants this short, hence the override.
const SIMULATED_DURATION_MS = Number(process.env.JOB_DURATION_MS) || 60000;

function workerName(): string {
  return process.env.HOSTNAME ?? "local";
}

async function simulated(job: Job): Promise<void> {
  console.log(`[${workerName()}] running job ${job.name}`);
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_DURATION_MS));
  console.log(`[${workerName()}] finished job ${job.name}`);
}

async function noop(job: Job): Promise<void> {
  console.log(`[${workerName()}] no-op job ${job.name}`);
}

/**
 * Reads the stored payload back as an HttpJobPayload.
 *
 * validation.ts normalises every field before the row is written, so a job
 * created through the API always has these. Rows that predate validation may
 * not, so the defaults are applied again here — and a missing url is a real
 * failure, reported as such so it lands in job_runs.error where it is visible
 * rather than being silently skipped.
 */
function readHttpPayload(job: Job): HttpJobPayload {
  const payload = (job.payload ?? {}) as Partial<HttpJobPayload>;

  if (typeof payload.url !== "string" || !payload.url.trim()) {
    throw new Error(
      `job "${job.name}" has handlerType "${job.handlerType}" but no payload.url — ` +
        `edit the job and set the URL it should call`
    );
  }

  return {
    url: payload.url.trim(),
    method: (payload.method ?? "GET").toUpperCase(),
    headers: payload.headers ?? {},
    body: payload.body,
    timeoutMs: Number(payload.timeoutMs) > 0 ? Number(payload.timeoutMs) : 10000,
    expectedStatus: Array.isArray(payload.expectedStatus)
      ? payload.expectedStatus
      : [],
  };
}

function isSuccess(status: number, expected: number[]): boolean {
  // An explicit list is exact. Empty means the usual contract: any 2xx.
  if (expected.length) return expected.includes(status);
  return status >= 200 && status < 300;
}

/**
 * Best-effort message for anything thrown by fetch.
 *
 * Deliberately structural rather than `instanceof Error`: an aborted request
 * rejects with a DOMException, and an error crossing a realm boundary (a Jest
 * sandbox, a vm context) fails the instanceof check even when it is an Error.
 * Both used to fall through to String(error) and lose the useful part.
 */
function describeError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { message, cause } = error as { message?: unknown; cause?: unknown };

    // undici reports every connection-level problem as a bare "fetch failed"
    // and puts the actual reason — ECONNREFUSED, ENOTFOUND, a bad port — on
    // cause. The cause is the only part that says what to change.
    if (cause && message === "fetch failed") return describeError(cause);
    if (typeof message === "string" && message) return message;
  }

  return String(error);
}

/**
 * Performs the job's configured HTTP request.
 *
 * Throwing is how a failure is recorded: executeWithRetry catches it, writes
 * the message to job_runs.error, and retries or dead-letters. So every message
 * thrown here is written on the assumption a human will read it in the Logs
 * page with no other context.
 */
async function http(job: Job): Promise<void> {
  const config = readHttpPayload(job);
  const worker = workerName();
  const started = Date.now();

  // AbortController is the only way to bound global fetch — it has no timeout
  // option, and without this a hung endpoint would hold the lease until the
  // job's heartbeat stopped, which reads as a dead worker rather than a slow
  // request.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  console.log(
    `[${worker}] http ${config.method} ${config.url} ` +
      `(job ${job.name}, timeout ${config.timeoutMs}ms)`
  );

  let response: Response;

  try {
    response = await fetch(config.url, {
      method: config.method,
      headers: config.headers,
      body: config.body,
      signal: controller.signal,
      redirect: "follow",
    });
  } catch (error) {
    // Worth distinguishing from DNS or connection failures because the fix is
    // different: raise timeoutMs versus fix the URL or the network.
    //
    // The signal is the reliable test. Sniffing error.name is not: the rejection
    // is a DOMException, and `instanceof Error` on it is false across a realm
    // boundary, so a timeout could be reported as a generic failure with the
    // configured timeout nowhere in the message.
    if (controller.signal.aborted) {
      throw new Error(
        `${config.method} ${config.url} timed out after ${config.timeoutMs}ms`
      );
    }

    throw new Error(
      `${config.method} ${config.url} failed: ${describeError(error)}`
    );
  } finally {
    clearTimeout(timer);
  }

  const elapsed = Date.now() - started;

  if (!isSuccess(response.status, config.expectedStatus)) {
    // A slice of the body usually contains the actual reason for a 4xx/5xx,
    // and truncating keeps one bad job from writing a megabyte into job_runs.
    let excerpt = "";

    try {
      const text = await response.text();
      if (text) excerpt = ` — ${text.slice(0, 500).replace(/\s+/g, " ").trim()}`;
    } catch {
      // A body that cannot be read does not change the verdict.
    }

    const wanted = config.expectedStatus.length
      ? `expected ${config.expectedStatus.join(" or ")}`
      : "expected 2xx";

    throw new Error(
      `${config.method} ${config.url} returned ${response.status} ` +
        `${response.statusText} after ${elapsed}ms (${wanted})${excerpt}`
    );
  }

  console.log(
    `[${worker}] http ${config.method} ${config.url} -> ${response.status} ` +
      `in ${elapsed}ms (job ${job.name})`
  );
}

const handlers: Record<string, Handler> = {
  http,
  // Same mechanics; the separate name is what the dashboard offers for
  // outbound notifications, and keeping it distinct means a job's intent
  // survives in the column.
  webhook: http,
  noop,
  simulated,
};

/** Handler names the API will accept. Kept in sync with validation.ts. */
export const HANDLER_NAMES = Object.keys(handlers);

/**
 * Dispatches on job.handlerType, falling back to the simulated handler for any
 * type with no registered implementation.
 *
 * Unknown types resolve rather than throw on purpose: throwing would burn all
 * three retries and dead-letter the job over a deployment gap — a handler that
 * exists on some instances and not others — rather than over a real failure.
 */
export const jobHandler: JobHandler = async (job) => {
  const handler = handlers[job.handlerType];

  if (!handler) {
    console.warn(
      `[${workerName()}] no handler registered for ` +
        `"${job.handlerType}", running simulated handler`
    );

    return simulated(job);
  }

  return handler(job);
};
