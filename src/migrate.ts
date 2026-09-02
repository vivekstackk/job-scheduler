import { readdirSync, readFileSync } from "fs";
import { join } from "path";

import { pool } from "./db";

// sql/ sits next to src/ in development and next to dist/ after a build, so
// one relative hop up resolves in both cases.
const MIGRATIONS_DIR = join(__dirname, "..", "sql");

// Any 64-bit constant works; it only has to be the same number in every
// process that might migrate concurrently.
const ADVISORY_LOCK_KEY = 4021755301;

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

// Exported for tests: these two are the only parts of the runner that can be
// exercised without a live database, and a BOM slipping through is exactly the
// kind of failure that only shows up as a Postgres syntax error at deploy time.
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

export function readMigration(name: string): string {
  const sql = readFileSync(join(MIGRATIONS_DIR, name), "utf8");

  // The checked-in .sql files are BOM-prefixed. Postgres rejects a byte order
  // mark ahead of the first statement, so it has to come off before execution.
  return sql.replace(/^﻿/, "");
}

/**
 * Applies every unapplied file in sql/ in filename order, recording each one in
 * schema_migrations so reruns are no-ops.
 *
 * Safe to call from every booting instance at once: a Postgres advisory lock
 * serialises the whole run, so the second caller waits and then finds nothing
 * left to do rather than racing the first through the same CREATE TABLEs.
 */
export async function runMigrations(): Promise<MigrationResult> {
  const client = await pool.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await client.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migrations"
    );
    const done = new Set(rows.map((row) => row.filename));

    for (const name of migrationFiles()) {
      if (done.has(name)) {
        skipped.push(name);
        continue;
      }

      // Each migration is its own transaction: a failure half way through a
      // batch leaves the files before it applied and recorded, so a rerun
      // resumes at the one that broke instead of starting over.
      await client.query("BEGIN");

      try {
        await client.query(readMigration(name));
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [name]
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${name} failed: ${describe(error)}`);
      }

      applied.push(name);
    }
  } finally {
    // Released even on failure, or every later boot would block on this lock.
    await client
      .query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY])
      .catch(() => {
        // The connection is being discarded anyway; an unlock failure here
        // would mask the real error from the migration above.
      });

    client.release();
  }

  return { applied, skipped };
}

// pg raises an AggregateError with an empty message when every address for a host
// is refused, which turns a plain error.message into "Migration failed: " — the
// least useful output possible for the error people hit most.
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors
      .map((inner: Error) => inner.message)
      .filter(Boolean);

    return causes.length
      ? causes.join("; ")
      : error.message || "could not connect to the database";
  }

  const message = (error as Error)?.message;
  const code = (error as { code?: string })?.code;

  if (message) return code ? `${message} (${code})` : message;

  return code ? `database error ${code}` : String(error);
}

// `npm run migrate` — standalone entrypoint. Only runs when this module is the
// process entry, so importing it from index.ts does not trigger a second run.
if (require.main === module) {
  runMigrations()
    .then(({ applied, skipped }) => {
      for (const name of skipped) console.log(`already applied  ${name}`);
      for (const name of applied) console.log(`applied          ${name}`);

      console.log(
        applied.length
          ? `\n${applied.length} migration(s) applied.`
          : "\nSchema already up to date."
      );

      return pool.end();
    })
    .catch((error: unknown) => {
      console.error(`Migration failed: ${describe(error)}`);
      console.error(
        "\nCheck DATABASE_URL, and that Postgres is running " +
          "(docker compose up -d postgres)."
      );

      process.exit(1);
    });
}
