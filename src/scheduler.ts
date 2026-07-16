import { Cron } from "croner";

export function computeNextRun(cronExpression: string, fromDate: Date = new Date()): Date | null {
  const job = new Cron(cronExpression, { timezone: "UTC" });
  const next = job.nextRun(fromDate);
  return next;
}