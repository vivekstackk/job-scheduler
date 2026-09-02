import { migrationFiles, readMigration } from "../src/migrate";

// DB-free, like tests/auth.test.ts. Importing src/migrate pulls in the pool but
// never connects, because runMigrations is not called here.
describe("migration runner", () => {
  it("finds the checked-in migrations", () => {
    const files = migrationFiles();

    expect(files).toContain("001_create_jobs.sql");
    expect(files).toContain("002_create_job_runs.sql");
    expect(files).toContain("003_add_locking_columns.sql");
  });

  it("orders migrations by filename so 002 never runs before 001", () => {
    const files = migrationFiles();

    // 002 references jobs(id), so applying it first is a foreign key error.
    expect(files.indexOf("001_create_jobs.sql")).toBeLessThan(
      files.indexOf("002_create_job_runs.sql")
    );
    expect(files.indexOf("002_create_job_runs.sql")).toBeLessThan(
      files.indexOf("003_add_locking_columns.sql")
    );
  });

  it("ignores anything that is not .sql", () => {
    expect(migrationFiles().every((name) => name.endsWith(".sql"))).toBe(true);
  });

  // The whole reason readMigration exists. A leading U+FEFF makes Postgres fail
  // with a syntax error at the first token, which on a managed host surfaces as
  // a crashed boot rather than an obvious message.
  it("strips the byte order mark so SQL starts at a real token", () => {
    for (const name of migrationFiles()) {
      const sql = readMigration(name);

      expect(sql.charCodeAt(0)).not.toBe(0xfeff);
      expect(sql).toMatch(/^(CREATE|ALTER|DROP|INSERT|--)/i);
    }
  });

  it("returns the full statement text, not just the first line", () => {
    const sql = readMigration("001_create_jobs.sql");

    expect(sql).toContain("cron_expression");
    expect(sql).toContain("next_run_at");
    expect(sql.trim().endsWith(";")).toBe(true);
  });
});
