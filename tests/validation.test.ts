import { validateCreateJob, validateUpdateJob } from "../src/validation";
import { HttpError } from "../src/errors";

/**
 * DB-free. validateCreateJob/validateUpdateJob run before any query, which is
 * the whole point of them: a bad request used to reach Postgres and come back
 * as a flat 500 "Internal Server Error" with nothing the caller could act on.
 */

/** Captures the thrown HttpError so status and message can both be asserted. */
function reject(body: unknown): HttpError {
  try {
    validateCreateJob(body);
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }

  throw new Error("expected validateCreateJob to reject, but it returned");
}

const valid = {
  name: "daily-report",
  cronExpression: "0 9 * * *",
  handlerType: "noop",
};

describe("validateCreateJob", () => {
  it("accepts a minimal job and defaults the payload to an object", () => {
    const input = validateCreateJob(valid);

    expect(input.name).toBe("daily-report");
    expect(input.handlerType).toBe("noop");
    expect(input.payload).toEqual({});
  });

  it("trims whitespace rather than storing it", () => {
    const input = validateCreateJob({ ...valid, name: "  spaced  " });

    expect(input.name).toBe("spaced");
  });

  it("rejects a body that is not an object", () => {
    expect(reject("nope").statusCode).toBe(400);
    expect(reject([]).message).toMatch(/JSON object/);
  });

  it("rejects a missing name with a 400 that names the field", () => {
    const error = reject({ ...valid, name: "" });

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/^name is required/);
  });

  it("rejects a name longer than the column allows", () => {
    const error = reject({ ...valid, name: "x".repeat(121) });

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/120 characters or fewer/);
  });

  it("rejects an unparseable cron expression", () => {
    const error = reject({ ...valid, cronExpression: "not a cron" });

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/is not a valid cron/);
  });

  it("accepts the one-minute expression the dashboard suggests", () => {
    expect(validateCreateJob({ ...valid, cronExpression: "* * * * *" })
      .cronExpression).toBe("* * * * *");
  });

  // The reason ISSUE 2 looked like "jobs never execute": a job could be created
  // with a handlerType nothing dispatches on, so it silently ran the simulated
  // handler instead of the work its author intended.
  it("rejects a handlerType with no registered handler", () => {
    const error = reject({ ...valid, handlerType: "send-report" });

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/no registered handler/);
    // The message has to say what *is* accepted, or the caller is guessing.
    expect(error.message).toMatch(/http, webhook, noop, simulated/);
  });

  it("reports every problem at once, not just the first", () => {
    const error = reject({ name: "", cronExpression: "??", handlerType: "zzz" });

    expect(error.details).toBeDefined();
    expect(error.details!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("validateCreateJob — http payload", () => {
  const http = { ...valid, handlerType: "http" };

  // ISSUE 4: an http job with no URL has nothing to call. It used to be
  // creatable, and then failed on every attempt with a message that only
  // appeared in the Logs page.
  it("rejects an http job with no payload at all", () => {
    const error = reject(http);

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/requires a payload containing at least a url/);
  });

  it("rejects an http job whose payload has no url", () => {
    expect(reject({ ...http, payload: { method: "POST" } }).message).toMatch(
      /^payload\.url is required/
    );
  });

  it("rejects a url that is not absolute", () => {
    expect(reject({ ...http, payload: { url: "/reports/daily" } }).message).toMatch(
      /not a valid absolute URL/
    );
  });

  it("rejects a non-http scheme", () => {
    expect(
      reject({ ...http, payload: { url: "file:///etc/passwd" } }).message
    ).toMatch(/must use http or https/);
  });

  it("fills in the defaults the handler would otherwise have to guess", () => {
    const input = validateCreateJob({
      ...http,
      payload: { url: "https://api.example.com/tasks" },
    });

    expect(input.payload).toMatchObject({
      url: "https://api.example.com/tasks",
      method: "GET",
      headers: {},
      timeoutMs: 10000,
      expectedStatus: [],
    });
  });

  it("uppercases the method and rejects one that is not a real verb", () => {
    expect(
      validateCreateJob({ ...http, payload: { url: "https://x.test/", method: "post" } })
        .payload!.method
    ).toBe("POST");

    expect(
      reject({ ...http, payload: { url: "https://x.test/", method: "FETCH" } }).message
    ).toMatch(/is not supported/);
  });

  it("rejects headers that are not an object of strings", () => {
    expect(
      reject({ ...http, payload: { url: "https://x.test/", headers: "authorization" } })
        .message
    ).toMatch(/payload\.headers must be an object/);

    expect(
      reject({ ...http, payload: { url: "https://x.test/", headers: { retries: 3 } } })
        .message
    ).toMatch(/payload\.headers\["retries"\] must be a string/);
  });

  it("serialises an object body at create time so it cannot fail at run time", () => {
    const input = validateCreateJob({
      ...http,
      payload: { url: "https://x.test/", method: "POST", body: { id: 7 } },
    });

    expect(input.payload!.body).toBe('{"id":7}');
  });

  // GET with a body is rejected by fetch itself, so allowing it would produce a
  // job that fails every attempt for a reason the author cannot see.
  it("rejects a body on GET and HEAD", () => {
    expect(
      reject({ ...http, payload: { url: "https://x.test/", body: "x" } }).message
    ).toMatch(/payload\.body is not allowed with method GET/);
  });

  it("bounds the timeout", () => {
    expect(
      reject({ ...http, payload: { url: "https://x.test/", timeoutMs: 0 } }).message
    ).toMatch(/between 1 and 120000/);

    expect(
      reject({ ...http, payload: { url: "https://x.test/", timeoutMs: 120001 } })
        .statusCode
    ).toBe(400);

    expect(
      validateCreateJob({ ...http, payload: { url: "https://x.test/", timeoutMs: "2500" } })
        .payload!.timeoutMs
    ).toBe(2500);
  });

  it("accepts an explicit expectedStatus list and rejects nonsense codes", () => {
    expect(
      validateCreateJob({
        ...http,
        payload: { url: "https://x.test/", expectedStatus: [200, 204] },
      }).payload!.expectedStatus
    ).toEqual([200, 204]);

    expect(
      reject({ ...http, payload: { url: "https://x.test/", expectedStatus: 99 } }).message
    ).toMatch(/not an HTTP status code/);
  });

  it("keeps unknown payload keys instead of silently dropping them", () => {
    const input = validateCreateJob({
      ...http,
      payload: { url: "https://x.test/", note: "kept" },
    });

    expect(input.payload!.note).toBe("kept");
  });

  it("holds webhook to the same contract as http", () => {
    expect(reject({ ...valid, handlerType: "webhook" }).statusCode).toBe(400);
  });

  // A noop job has no URL to check, so its payload passes through untouched.
  it("leaves a non-http handler's payload alone", () => {
    const input = validateCreateJob({ ...valid, payload: { anything: [1, 2] } });

    expect(input.payload).toEqual({ anything: [1, 2] });
  });
});

describe("validateUpdateJob", () => {
  const existingNoop = { handlerType: "noop", payload: {} };
  const existingHttp = {
    handlerType: "http",
    payload: { url: "https://x.test/", method: "GET" },
  };

  function rejectUpdate(
    body: unknown,
    existing = existingNoop
  ): HttpError {
    try {
      validateUpdateJob(body, existing);
    } catch (error) {
      if (error instanceof HttpError) return error;
      throw error;
    }

    throw new Error("expected validateUpdateJob to reject, but it returned");
  }

  // PUT is a merge, so an empty body is a no-op rather than an error.
  it("returns only the fields the caller actually sent", () => {
    expect(validateUpdateJob({ name: "renamed" }, existingNoop)).toEqual({
      name: "renamed",
    });

    expect(validateUpdateJob({}, existingNoop)).toEqual({});
  });

  it("accepts the pause and resume transitions the dashboard sends", () => {
    expect(validateUpdateJob({ status: "paused" }, existingNoop).status).toBe("paused");
    expect(validateUpdateJob({ status: "active" }, existingNoop).status).toBe("active");
  });

  it("rejects a status outside the enum", () => {
    const error = rejectUpdate({ status: "running" });

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/status must be one of active, paused, dead_letter/);
  });

  it("checks a changed cron the same way create does", () => {
    expect(rejectUpdate({ cronExpression: "61 * * * *" }).statusCode).toBe(400);
    expect(
      validateUpdateJob({ cronExpression: "*/5 * * * *" }, existingNoop).cronExpression
    ).toBe("*/5 * * * *");
  });

  it("checks a changed handlerType the same way create does", () => {
    expect(rejectUpdate({ handlerType: "send-report" }).message).toMatch(
      /no registered handler/
    );
  });

  // Editing just the URL is the common case, and the caller does not restate
  // the handler — so the existing one has to supply the contract.
  it("applies the http contract to a payload-only edit of an http job", () => {
    expect(rejectUpdate({ payload: { url: "" } }, existingHttp).message).toMatch(
      /^payload\.url is required/
    );

    const changes = validateUpdateJob(
      { payload: { url: "https://y.test/hook", method: "POST" } },
      existingHttp
    );

    expect(changes.payload).toMatchObject({
      url: "https://y.test/hook",
      method: "POST",
      timeoutMs: 10000,
    });
  });

  // Otherwise the job would be switched to http with nothing to call and fail
  // on every attempt until someone read the Logs page. The stored payload is
  // re-checked against the new handler's contract, so the error names the field
  // the caller has to supply.
  it("rejects switching a job to http without supplying a url", () => {
    const error = rejectUpdate({ handlerType: "http" }, existingNoop);

    expect(error.statusCode).toBe(400);
    expect(error.message).toMatch(/^payload\.url is required/);
  });

  it("allows switching away from http without restating the payload", () => {
    expect(validateUpdateJob({ handlerType: "noop" }, existingHttp)).toEqual({
      handlerType: "noop",
    });
  });
});



