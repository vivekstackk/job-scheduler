/**
 * Typed HTTP errors.
 *
 * Before this existed, every failure below the route layer reached Fastify's
 * default handler as a bare Error and came back to the dashboard as a flat
 * "Internal Server Error" with a 500 — including plain bad input, like a name
 * the database rejected for being null. The caller could not tell "you sent
 * something invalid" from "the server is broken".
 *
 * Throwing one of these carries the intended status and a message that is safe
 * to show a user. Anything that is *not* an HttpError is treated as genuinely
 * unexpected: logged with its stack, answered with a generic 500.
 */
export class HttpError extends Error {
  readonly statusCode: number;
  readonly details?: string[];

  constructor(statusCode: number, message: string, details?: string[]) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.details = details;

    // Without this the prototype chain is lost when compiled to ES5-era
    // output and `instanceof HttpError` fails in the error handler.
    Object.setPrototypeOf(this, HttpError.prototype);
  }
}

export function badRequest(message: string, details?: string[]): HttpError {
  return new HttpError(400, message, details);
}

export function notFound(message = "job not found"): HttpError {
  return new HttpError(404, message);
}

export function conflict(message: string): HttpError {
  return new HttpError(409, message);
}

/** Postgres SQLSTATEs that are caused by the request, not by the server. */
const PG_CODES: Record<string, { status: number; message: string }> = {
  // invalid text representation, e.g. a malformed UUID in a path parameter
  "22P02": { status: 400, message: "malformed identifier or value" },
  // not_null_violation
  "23502": { status: 400, message: "a required field was missing" },
  // foreign_key_violation
  "23503": { status: 409, message: "referenced record does not exist" },
  // unique_violation
  "23505": { status: 409, message: "a record with that value already exists" },
  // string_data_right_truncation
  "22001": { status: 400, message: "a field was longer than the column allows" },
};

export function pgErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Maps a driver-level Postgres error to a client error where the SQLSTATE says
 * the request caused it. Returns undefined for anything else, which the caller
 * should treat as a real 500.
 */
export function asClientError(error: unknown): HttpError | undefined {
  const code = pgErrorCode(error);
  if (!code) return undefined;

  const mapped = PG_CODES[code];
  if (!mapped) return undefined;

  return new HttpError(mapped.status, mapped.message);
}
