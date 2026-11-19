import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { claimScheduledJob, releaseScheduledJobClaim } from "./scheduler-claim.js";

function profileLockKey(profileId: string): bigint {
  let h = 0n;
  for (let i = 0; i < profileId.length; i++) {
    h = (h * 31n + BigInt(profileId.charCodeAt(i))) & 0x7FFFFFFFFFFFFFFFn;
  }
  return h;
}

export async function checkAndAwardBadges(profileId: string, prismaClient = prisma): Promise<void> {
  const lockKey = profileLockKey(profileId);

  try {
    await prismaClient.$transaction(async (tx) => {
      // Serialize concurrent badge checks for the same profile using a
      // transaction-scoped advisory lock. Concurrent callers block until the
      // current check commits, then each runs with the latest DB state rather
      // than being silently dropped.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockKey})`;

      const badges = await tx.badge.findMany();
      if (badges.length === 0) return;

      const existingAwards = await tx.profileBadge.findMany({
        where: { profileId },
        select: { badgeId: true },
      });
      const awardedBadgeIds = new Set(existingAwards.map((a) => a.badgeId));

      if (awardedBadgeIds.size === badges.length) return;

      const [txCount, uniqueSupporters, totalsByAsset, milestonesReached] = await Promise.all([
        tx.supportTransaction.count({
          where: { profileId, status: "SUCCESS" },
        }),
        tx.supportTransaction.findMany({
          where: { profileId, supporterAddress: { not: null }, status: "SUCCESS" },
          distinct: ["supporterAddress"],
          select: { supporterAddress: true },
        }),
        tx.supportTransaction.groupBy({
          by: ["assetCode", "assetIssuer"],
          where: { profileId, status: "SUCCESS" },
          _sum: { amount: true },
        }),
        tx.milestone.count({
          where: { profileId, status: "reached" },
        }),
      ]);

      const xlmTotal = totalsByAsset
        .filter((g) => g.assetCode === "XLM" && g.assetIssuer === null)
        .reduce((sum, g) => sum + Number(g._sum.amount ?? 0), 0);

      for (const badge of badges) {
        if (awardedBadgeIds.has(badge.id)) continue;

        let shouldAward = false;

        switch (badge.criteria) {
          case "first_support":
            shouldAward = txCount >= 1;
            break;
          case "ten_supporters":
            shouldAward = uniqueSupporters.length >= 10;
            break;
          case "total_100_xlm":
            shouldAward = xlmTotal >= 100;
            break;
          case "milestone_reached":
            shouldAward = milestonesReached >= 1;
            break;
          default:
            logger.warn(
              { criteria: badge.criteria, badgeId: badge.id },
              "Unknown badge criteria — badge will never be auto-awarded",
            );
            break;
        }

        if (shouldAward) {
          try {
            await tx.profileBadge.create({
              data: { profileId, badgeId: badge.id },
            });
            logger.info(
              { profileId, badgeName: badge.name },
              "Badge auto-awarded",
            );
          } catch (e: any) {
            if (e?.code !== "P2002") throw e;
          }
        }
      }
    }, { timeout: 30000 });
  } catch (err) {
    logger.error(
      { err, profileId },
      "Error in checkAndAwardBadges",
    );
  }
}

const BADGE_SWEEP_BATCH_SIZE = 100;
export const BADGE_SWEEP_JOB_NAME = "badge-sweep";
export const BADGE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Re-check every profile with recorded support activity for any badge it has
 * earned but not yet been awarded.
 *
 * The reactive post-transaction check in the API is fire-and-forget, so a
 * single DB blip or lock timeout can leave a user forever without a badge they
 * crossed the threshold for. This recurring sweep is the safety net that
 * eventually grants it (#1354).
 *
 * Only profiles with at least one non-failed support transaction are scanned —
 * every badge criterion depends on such a transaction, so this avoids walking
 * the entire profile table. Batched by id to bound memory on large datasets.
 *
 * Returns the number of profiles checked.
 */
export async function sweepBadges(
  prismaClient = prisma,
  checkFn: typeof checkAndAwardBadges = checkAndAwardBadges,
): Promise<number> {
  let cursor: string | undefined;
  let swept = 0;

  do {
    const profiles = await prismaClient.profile.findMany({
      where: { supportTransactions: { some: { status: "SUCCESS" } } },
      select: { id: true },
      take: BADGE_SWEEP_BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (profiles.length === 0) break;

    for (const profile of profiles) {
      await checkFn(profile.id, prismaClient);
      swept += 1;
    }

    cursor =
      profiles.length === BADGE_SWEEP_BATCH_SIZE
        ? profiles[profiles.length - 1]?.id
        : undefined;
  } while (cursor !== undefined);

  return swept;
}

/**
 * Claim and run the badge sweep only if the interval has elapsed. The claim is
 * persisted so a restart, rolling deploy, or multiple replicas do not all run
 * the sweep at once. A failed run releases its claim so the next tick retries
 * immediately instead of waiting out a full interval.
 */
export async function maybeRunBadgeSweep(
  prismaClient = prisma,
  sweep: typeof sweepBadges = sweepBadges,
): Promise<void> {
  const runAt = new Date();

  if (
    !(await claimScheduledJob(
      BADGE_SWEEP_JOB_NAME,
      BADGE_SWEEP_INTERVAL_MS,
      prismaClient,
      runAt,
    ))
  ) {
    logger.debug("Badge sweep skipped — not yet due or already claimed");
    return;
  }

  try {
    const swept = await sweep(prismaClient);
    logger.info({ swept }, "Badge sweep completed");
  } catch (err) {
    await releaseScheduledJobClaim(BADGE_SWEEP_JOB_NAME, runAt, prismaClient).catch(
      (releaseErr) => {
        logger.error({ err: releaseErr }, "Failed to release badge sweep claim");
      },
    );
    throw err;
  }
}

let badgeSweepInterval: ReturnType<typeof setInterval> | null = null;

export function startBadgeSweepScheduler() {
  if (badgeSweepInterval) {
    logger.warn("Badge sweep scheduler already running; ignoring duplicate start");
    return;
  }
  logger.info("Badge sweep scheduler starting...");

  maybeRunBadgeSweep().catch((err) => {
    logger.error({ err }, "Error in initial badge sweep");
  });

  badgeSweepInterval = setInterval(() => {
    maybeRunBadgeSweep().catch((err) => {
      logger.error({ err }, "Error in badge sweep interval");
    });
  }, BADGE_SWEEP_INTERVAL_MS);
}

export function stopBadgeSweepScheduler() {
  if (badgeSweepInterval) {
    clearInterval(badgeSweepInterval);
    badgeSweepInterval = null;
  }
}
