import { Cron } from "croner";

import { badRequest } from "./errors";
import { CreateJobInput, HttpJobPayload, JobStatus } from "./types";
import { UpdateJobInput } from "./jobStore";

/**
 * Request validation for the job routes.
 *
 * The routes used to hand request.body straight to the store, so the first
 * thing that saw a bad request was Postgres, and the caller got a 500 with no
 * usable message. Everything here runs before any query and throws a 400 that
 * names the offending field.
 */

const NAME_MAX = 120;
const HANDLER_TYPES = ["http", "webhook", "noop", "simulated"] as const;
const STATUSES: JobStatus[] = ["active", "paused", "dead_letter"];

/** Handlers that perform an outbound request and therefore need a URL. */
const HTTP_HANDLERS = new Set(["http", "webhook"]);

const HTTP_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 120000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function requireString(
  value: unknown,
  field: string,
  errors: string[]
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${field} is required and must be a non-empty string`);
    return undefined;
  }

  return value.trim();
}

/**
 * croner throws on an unparseable expression. It also accepts 6-field
 * expressions where the first field is seconds, which is legal here — the only
 * thing that matters is that computeNextRun can produce a date from it.
 */
function validateCron(expression: string, errors: string[]): void {
  try {
    const next = new Cron(expression, { timezone: "UTC" }).nextRun();

    if (!next) {
      errors.push(
        `cronExpression "${expression}" is valid but will never fire again`
      );
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    errors.push(`cronExpression "${expression}" is not a valid cron: ${reason}`);
  }
}

/**
 * Normalises and checks the payload for an http/webhook job.
 *
 * Returns a fully-populated HttpJobPayload so the handler never has to guess a
 * default at execution time — what was validated is exactly what gets stored.
 */
export function validateHttpPayload(
  payload: Record<string, unknown>,
  errors: string[]
): HttpJobPayload | undefined {
  const url = requireString(payload.url, "payload.url", errors);
  let parsed: URL | undefined;

  if (url) {
    try {
      parsed = new URL(url);
    } catch {
      errors.push(`payload.url "${url}" is not a valid absolute URL`);
    }

    if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("payload.url must use http or https");
    }
  }

  const method =
    payload.method === undefined
      ? "GET"
      : String(payload.method).toUpperCase().trim();

  if (!HTTP_METHODS.has(method)) {
    errors.push(
      `payload.method "${method}" is not supported (use ${[...HTTP_METHODS].join(", ")})`
    );
  }

  const headers: Record<string, string> = {};

  if (payload.headers !== undefined) {
    if (!isPlainObject(payload.headers)) {
      errors.push("payload.headers must be an object of string values");
    } else {
      for (const [key, value] of Object.entries(payload.headers)) {
        if (typeof value !== "string") {
          errors.push(`payload.headers["${key}"] must be a string`);
          continue;
        }

        headers[key] = value;
      }
    }
  }

  let body: string | undefined;

  if (payload.body !== undefined && payload.body !== null && payload.body !== "") {
    // Objects are serialised here rather than at execution time so an
    // unserialisable body fails at create time, where the caller can see it.
    if (typeof payload.body === "string") {
      body = payload.body;
    } else {
      try {
        body = JSON.stringify(payload.body);
      } catch {
        errors.push("payload.body could not be serialised to JSON");
      }
    }

    if (method === "GET" || method === "HEAD") {
      errors.push(`payload.body is not allowed with method ${method}`);
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;

  if (payload.timeoutMs !== undefined) {
    const value = Number(payload.timeoutMs);

    if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
      errors.push(
        `payload.timeoutMs must be a number between 1 and ${MAX_TIMEOUT_MS}`
      );
    } else {
      timeoutMs = Math.floor(value);
    }
  }

  const expectedStatus: number[] = [];

  if (payload.expectedStatus !== undefined) {
    const raw = Array.isArray(payload.expectedStatus)
      ? payload.expectedStatus
      : [payload.expectedStatus];

    for (const entry of raw) {
      const code = Number(entry);

      if (!Number.isInteger(code) || code < 100 || code > 599) {
        errors.push(
          `payload.expectedStatus contains "${entry}", which is not an HTTP status code`
        );
        continue;
      }

      expectedStatus.push(code);
    }
  }

  if (errors.length) return undefined;

  return {
    url: url as string,
    method,
    headers,
    body,
    timeoutMs,
    expectedStatus,
  };
}

/**
 * Validates a payload against whatever its handler needs. Handlers with no
 * required shape pass their object through untouched.
 */
function validatePayloadFor(
  handlerType: string,
  payload: unknown,
  errors: string[]
): Record<string, unknown> {
  if (payload === undefined || payload === null) {
    if (HTTP_HANDLERS.has(handlerType)) {
      errors.push(
        `handlerType "${handlerType}" requires a payload containing at least a url`
      );
    }

    return {};
  }

  if (!isPlainObject(payload)) {
    errors.push("payload must be a JSON object");
    return {};
  }

  if (!HTTP_HANDLERS.has(handlerType)) return payload;

  const normalised = validateHttpPayload(payload, errors);

  // Unknown keys are preserved: the handler ignores them, and silently
  // dropping something the caller sent would be worse than carrying it.
  return normalised ? { ...payload, ...normalised } : payload;
}

function validateHandlerType(value: unknown, errors: string[]): string | undefined {
  const handlerType = requireString(value, "handlerType", errors);
  if (!handlerType) return undefined;

  if (!(HANDLER_TYPES as readonly string[]).includes(handlerType)) {
    errors.push(
      `handlerType "${handlerType}" has no registered handler ` +
        `(use ${HANDLER_TYPES.join(", ")})`
    );

    return undefined;
  }

  return handlerType;
}

function raise(errors: string[]): never {
  throw badRequest(errors[0], errors);
}

export function validateCreateJob(body: unknown): CreateJobInput {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    raise(["request body must be a JSON object"]);
  }

  const name = requireString(body.name, "name", errors);

  if (name && name.length > NAME_MAX) {
    errors.push(`name must be ${NAME_MAX} characters or fewer`);
  }

  const cronExpression = requireString(
    body.cronExpression,
    "cronExpression",
    errors
  );

  if (cronExpression) validateCron(cronExpression, errors);

  const handlerType = validateHandlerType(body.handlerType, errors);
  const payload = validatePayloadFor(handlerType ?? "", body.payload, errors);

  if (errors.length) raise(errors);

  return {
    name: name as string,
    cronExpression: cronExpression as string,
    handlerType: handlerType as string,
    payload,
  };
}

/**
 * PUT is a merge, so every field is optional — but a field that *is* present
 * gets exactly the same scrutiny as it would on create.
 *
 * `existing` supplies the handler type when the caller changes a payload
 * without restating the handler, which is the common case for editing a URL.
 */
export function validateUpdateJob(
  body: unknown,
  existing: { handlerType: string; payload: Record<string, unknown> }
): UpdateJobInput {
  const errors: string[] = [];

  if (!isPlainObject(body)) {
    raise(["request body must be a JSON object"]);
  }

  const changes: UpdateJobInput = {};

  if (body.name !== undefined) {
    const name = requireString(body.name, "name", errors);

    if (name && name.length > NAME_MAX) {
      errors.push(`name must be ${NAME_MAX} characters or fewer`);
    }

    if (name) changes.name = name;
  }

  if (body.cronExpression !== undefined) {
    const cronExpression = requireString(
      body.cronExpression,
      "cronExpression",
      errors
    );

    if (cronExpression) {
      validateCron(cronExpression, errors);
      changes.cronExpression = cronExpression;
    }
  }

  if (body.handlerType !== undefined) {
    const handlerType = validateHandlerType(body.handlerType, errors);
    if (handlerType) changes.handlerType = handlerType;
  }

  if (body.status !== undefined) {
    if (
      typeof body.status !== "string" ||
      !STATUSES.includes(body.status as JobStatus)
    ) {
      errors.push(`status must be one of ${STATUSES.join(", ")}`);
    } else {
      changes.status = body.status as JobStatus;
    }
  }

  const handlerType = changes.handlerType ?? existing.handlerType;

  if (body.payload !== undefined) {
    changes.payload = validatePayloadFor(handlerType, body.payload, errors);
  } else if (
    changes.handlerType &&
    HTTP_HANDLERS.has(changes.handlerType) &&
    !HTTP_HANDLERS.has(existing.handlerType)
  ) {
    // Switching a job to http without supplying a payload would leave it with
    // nothing to call, and the handler would fail on every attempt until
    // someone noticed. Reject it at the edit instead.
    changes.payload = validatePayloadFor(
      changes.handlerType,
      existing.payload,
      errors
    );
  }

  if (errors.length) raise(errors);

  return changes;
}
