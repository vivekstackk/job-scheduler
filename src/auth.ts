import { timingSafeEqual } from "crypto";
import { FastifyInstance } from "fastify";

const HEADER = "x-api-key";

// Reads and writes are deliberately split. This API backs a public dashboard,
// so the job list stays readable by anyone, while anything that mutates or
// destroys state needs the key. A key shipped in a static frontend bundle is
// not secret, so gating reads on it would buy nothing anyway.
const OPEN_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);

  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Comparing the digests of equal-length buffers is the usual way around it;
  // here a length check plus the constant-time compare is enough, since key
  // length is not the secret.
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}

let warned = false;

export function registerApiKeyAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request, reply) => {
    // Read per request rather than at registration so tests can set and clear
    // API_KEY around individual cases without rebuilding the server.
    const expected = process.env.API_KEY?.trim();

    if (!expected) {
      if (!warned) {
        warned = true;
        app.log.warn(
          "API_KEY is not set — write endpoints (POST/PUT/DELETE) are unauthenticated. " +
            "Set API_KEY to require a key on mutations."
        );
      }

      return;
    }

    if (OPEN_METHODS.has(request.method)) return;
    if (request.url === "/health") return;

    const provided = request.headers[HEADER];
    const supplied = Array.isArray(provided) ? provided[0] : provided;

    if (!supplied || !constantTimeEquals(supplied, expected)) {
      reply.code(401);

      // Says which header to send without hinting at the value, so a legitimate
      // caller can fix a misconfiguration from the error alone.
      return reply.send({
        error: `write access requires a valid ${HEADER} header`,
      });
    }
  });
}
