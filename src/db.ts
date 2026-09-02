import { Pool, PoolConfig } from "pg";
import * as dotenv from "dotenv";

dotenv.config();

const connectionString = process.env.DATABASE_URL ?? "";

// Managed Postgres (Render, Heroku, Supabase, RDS) terminates TLS with a
// certificate this process has no CA for, so verification has to be relaxed —
// but only for remote hosts. A local container needs SSL off entirely, and
// enabling it there fails the handshake outright.
//
// Detection is by host rather than NODE_ENV so that `npm test` against a
// remote database behaves correctly too. DATABASE_SSL overrides both ways
// for the cases this heuristic gets wrong.
function isLocalHost(url: string): boolean {
  return /@(localhost|127\.0\.0\.1|\[::1\]|postgres|host\.docker\.internal)([:/]|$)/.test(
    url
  );
}

function resolveSsl(): PoolConfig["ssl"] {
  const override = process.env.DATABASE_SSL?.trim().toLowerCase();

  if (override === "disable" || override === "false") return undefined;
  if (override === "require" || override === "true") {
    return { rejectUnauthorized: false };
  }

  if (!connectionString) return undefined;

  // sslmode in the URL is authoritative when present — pg reads it itself,
  // and a conflicting ssl option here would silently win over it.
  if (/[?&]sslmode=/.test(connectionString)) return undefined;

  return isLocalHost(connectionString)
    ? undefined
    : { rejectUnauthorized: false };
}

export const pool = new Pool({
  connectionString,
  ssl: resolveSsl(),
});
