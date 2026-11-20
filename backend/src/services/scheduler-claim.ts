import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";

/**
 * Atomically claim a scheduled job if it is due.
 *
 * The claim is a single conditional upsert: the row is written only when no row
 * exists yet (first run) or the persisted `lastRunAt` is at least `intervalMs`
 * old. Because the check and the write happen in one statement, two replicas
 * calling this concurrently can never both win — the loser sees zero rows
 * returned and skips, instead of double-running the job.
 *
 * Returns true when the caller owns the claim and should run the job.
 */
export async function claimScheduledJob(
  name: string,
  intervalMs: number,
  prismaClient = prisma,
  now = new Date(),
): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - intervalMs);
  const claimed = await prismaClient.$queryRaw<Array<{ name: string }>>(Prisma.sql`
    INSERT INTO "scheduler_jobs" ("name", "lastRunAt", "updatedAt")
    VALUES (${name}, ${now}, ${now})
    ON CONFLICT ("name") DO UPDATE
      SET "lastRunAt" = EXCLUDED."lastRunAt", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "scheduler_jobs"."lastRunAt" <= ${dueBefore}
    RETURNING "name"
  `);
  return claimed.length > 0;
}

/**
 * Give a claim back when the claimed run failed, so the next due-check fires
 * immediately instead of waiting out the full interval.
 *
 * The write is guarded on `lastRunAt` still being the value we claimed with, so
 * a run that already handed off to a later claim cannot roll back a newer one.
 */
export async function releaseScheduledJobClaim(
  name: string,
  claimedAt: Date,
  prismaClient = prisma,
): Promise<void> {
  await prismaClient.schedulerJob.updateMany({
    where: { name, lastRunAt: claimedAt },
    data: { lastRunAt: new Date(0) },
  });
}
