import crypto from "crypto";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { Metrics } from "../metrics.js";

const DRIP_BATCH_SIZE = 100;

export function addMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const targetMonth = result.getMonth() + months;
  result.setMonth(targetMonth);
  // setMonth overflows into the next month when the day doesn't exist
  // there (e.g. Jan 31 + 1 month -> Mar 3). Clamp to the last day of
  // the target month instead.
  if (result.getMonth() !== ((targetMonth % 12) + 12) % 12) {
    result.setDate(0);
  }
  return result;
}

export async function processDueRecurringSupports(prismaClient = prisma, now = new Date()) {
  let cursor: string | undefined;

  do {
    const dueSupports = await prismaClient.recurringSupport.findMany({
      where: {
        status: "active",
        nextRunAt: { lte: now },
      },
      include: {
        profile: true,
        supporter: true,
      },
      take: DRIP_BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (dueSupports.length === 0) break;

    for (const support of dueSupports) {
    // #608: supporterId is NULL when the supporter's account was deleted (SET NULL FK).
    // Mark the subscription cancelled so it stops appearing as due and so
    // the profile owner can see the cancellation in their dashboard.
    if (!support.supporter) {
      await prismaClient.recurringSupport.update({
        where: { id: support.id },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      logger.info({ dripId: support.id, profileId: support.profileId }, "Recurring support cancelled: supporter account deleted");
      continue;
    }

    try {
      const supporter = support.supporter;
      // Calculate nextRunAt based on frequency
      const nextRunAt =
        support.frequency === "weekly"
          ? new Date(support.nextRunAt.getTime() + 7 * 24 * 60 * 60 * 1000)
          : addMonths(support.nextRunAt, 1);

      // Atomic claim: only one scheduler instance wins the row
      const claimed = await prismaClient.$executeRaw`
        UPDATE "RecurringSupport"
        SET "nextRunAt" = ${nextRunAt}
        WHERE id = ${support.id} AND "nextRunAt" <= ${now} AND "status" = 'active'
      `;

      if (claimed === 0) {
        logger.info({ dripId: support.id }, "Recurring support already claimed by another process");
        continue;
      }

      await prismaClient.recurringSupportExecution.create({
        data: {
          recurringSupportId: support.id,
          status: "pending",
        },
      });

      logger.info({
        dripId: support.id,
        profileId: support.profileId,
        amount: support.amount.toString(),
        assetCode: support.assetCode,
        assetIssuer: support.assetIssuer,
      }, "Processed due recurring support");
      Metrics.dripsProcessed();

    } catch (error) {
      logger.error({
        err: error,
        dripId: support.id,
      }, "Failed to process recurring support");
      Metrics.dripErrors();
    }
  }

    cursor = dueSupports.length === DRIP_BATCH_SIZE
      ? dueSupports[dueSupports.length - 1].id
      : undefined;
  } while (cursor !== undefined);
}

export type SchedulerHandle = {
  stop(): Promise<void>;
};

let dripInterval: ReturnType<typeof setInterval> | null = null;
let dripInFlight: Promise<void> | null = null;
let dripStopped = true;

function runDripSchedulerTick(): void {
  dripInFlight = processDueRecurringSupports()
    .catch((err) => {
      logger.error({ err }, "Error in processDueRecurringSupports run");
    })
    .finally(() => {
      dripInFlight = null;
    });
}

export function startDripScheduler(): SchedulerHandle {
  if (process.env.DRIP_SCHEDULER_ENABLED === "true") {
    logger.info("Drip scheduler enabled. Starting...");
    dripStopped = false;
    
    // Initial run
    runDripSchedulerTick();
    
    // Then every 60 seconds
    dripInterval = setInterval(() => {
      if (!dripInFlight) {
        runDripSchedulerTick();
      }
    }, 60000);
  } else {
    logger.info("Drip scheduler disabled.");
  }

  return {
    async stop() {
      if (dripStopped) return;
      dripStopped = true;
      if (dripInterval) {
        clearInterval(dripInterval);
        dripInterval = null;
      }
      if (dripInFlight) {
        await dripInFlight;
      }
      logger.info("Drip scheduler stopped.");
    },
  };
}
