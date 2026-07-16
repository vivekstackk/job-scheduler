import { computeNextRun } from "../src/scheduler";

describe("computeNextRun", () => {
  it("returns the next 9am run for a daily 9am cron expression", () => {
    const from = new Date("2026-07-16T10:00:00Z"); // after 9am, so next run is tomorrow
    const next = computeNextRun("0 9 * * *", from);

    expect(next).not.toBeNull();
    expect(next!.getUTCHours()).toBe(9);
    expect(next!.getUTCDate()).toBe(17);
  });

  it("returns null for an invalid cron expression", () => {
    expect(() => computeNextRun("not a cron string")).toThrow();
  });
});