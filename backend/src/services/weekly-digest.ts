import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { sendEmail as defaultSendEmail } from "../mailer.js";
import { logger } from "../logger.js";
import { escapeHtml } from "./email.js";

const PROFILE_BATCH_SIZE = 100;

/**
 * A profile emailed this recently is skipped (#1499). If a run fails part way,
 * its claim is released and the retry starts again from the first profile;
 * without this, everyone emailed before the failure gets the week's digest
 * twice. Six days is shorter than the 7-day cadence, so it never suppresses
 * next week's digest, and longer than any retry of the current week.
 */
export const DIGEST_RESEND_GUARD_MS = 6 * 24 * 60 * 60 * 1000;

export async function sendWeeklyDigests(
  prismaClient = prisma,
  sendEmailFn: typeof defaultSendEmail = defaultSendEmail,
) {
  let cursor: string | undefined;
  let totalProfilesEmailed = 0;
  let totalErrors = 0;

  logger.info("Weekly digest run started");

  do {
    const profiles = await prismaClient.profile.findMany({
      where: {
        email: { not: null },
        emailVerified: true,
        notificationPreferences: { weeklyDigest: true },
      },
      include: {
        notificationPreferences: true,
      },
      take: PROFILE_BATCH_SIZE,
      orderBy: { id: "asc" },
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });

    if (profiles.length === 0) break;

    let profilesEmailed = 0;
    let errors = 0;

    for (const profile of profiles) {
      const lastSentAt = profile.notificationPreferences?.lastWeeklyDigestSentAt;
      if (lastSentAt && Date.now() - lastSentAt.getTime() < DIGEST_RESEND_GUARD_MS) {
        continue;
      }

      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [transactions, uniqueSupporters, milestonesReached, assetGroups] = await Promise.all([
          prismaClient.supportTransaction.findMany({
            where: {
              profileId: profile.id,
              status: "SUCCESS",
              createdAt: { gte: sevenDaysAgo },
            },
            orderBy: { createdAt: "desc" },
          }),
          prismaClient.supportTransaction.findMany({
            where: {
              profileId: profile.id,
              supporterAddress: { not: null },
              status: "SUCCESS",
              createdAt: { gte: sevenDaysAgo },
            },
            distinct: ["supporterAddress"],
            select: { supporterAddress: true },
          }),
          prismaClient.milestone.findMany({
            where: {
              profileId: profile.id,
              status: "reached",
              reachedAt: { gte: sevenDaysAgo },
            },
          }),
          prismaClient.supportTransaction.groupBy({
            by: ["assetCode"],
            where: {
              profileId: profile.id,
              status: "SUCCESS",
              createdAt: { gte: sevenDaysAgo },
            },
            _sum: { amount: true },
            _count: true,
          }),
        ]);

        // #656: totalReceived was removed — summing amounts across different asset
        // codes (XLM, USDC, AQUA, …) produces a meaningless cross-currency figure.
        // assetBreakdown already shows per-asset totals correctly.
        const txCount = transactions.length;
        const supporterCount = uniqueSupporters.length;
        const milestonesCount = milestonesReached.length;

        if (txCount === 0) continue;

        const assetBreakdown = assetGroups
          .map((g) => `${g._sum.amount?.toString() ?? "0"} ${escapeHtml(g.assetCode)}`)
          .join(", ");

        const milestonesSection =
          milestonesCount > 0
            ? `<p><strong>Milestones reached:</strong> ${milestonesCount}</p>`
            : "";

        const milestonesTextLine =
          milestonesCount > 0
            ? `\nMilestones reached this week: ${milestonesCount}`
            : "";

        const text =
          `Your Weekly NovaSupport Recap\n\n` +
          `Profile: ${profile.displayName}\n` +
          `Total received: ${assetBreakdown}\n` +
          `Transactions: ${txCount}\n` +
          `New supporters: ${supporterCount}` +
          milestonesTextLine +
          `\n\nView your profile: https://novasupport.xyz/${profile.username}\n\n` +
          `Thanks,\nThe NovaSupport Team\n\n` +
          `To stop receiving these emails, update your notification preferences:\n` +
          `https://novasupport.xyz/dashboard?settings=notifications`;

        const html = `
        <h2>Your Weekly NovaSupport Recap</h2>
        <p>Here's what happened with your profile <strong>${escapeHtml(profile.displayName)}</strong> this week:</p>
        <ul>
          <li><strong>Total received:</strong> ${assetBreakdown}</li>
          <li><strong>Transactions:</strong> ${txCount}</li>
          <li><strong>New supporters:</strong> ${supporterCount}</li>
        </ul>
        ${milestonesSection}
        <br/>
        <p><a href="https://novasupport.xyz/${encodeURIComponent(profile.username)}">View your profile</a></p>
        <br/>
        <p>Thanks,<br/>The NovaSupport Team</p>
        <br/>
        <p style="font-size:12px;color:#666">
          <a href="https://novasupport.xyz/dashboard?settings=notifications">Unsubscribe</a>
          from weekly emails
        </p>
      `;

        await sendEmailFn({
          to: profile.email!,
          subject: "Your NovaSupport weekly recap",
          text,
          html,
        });

        profilesEmailed++;

        try {
          await prismaClient.notificationPreferences.update({
            where: { profileId: profile.id },
            data: { lastWeeklyDigestSentAt: new Date() },
          });
        } catch (markErr) {
          // The email went out; only the marker failed, so a retry could resend.
          logger.warn(
            { err: markErr, profileId: profile.id },
            "Weekly digest sent but could not record it; a retry may resend",
          );
        }
      } catch (err) {
        logger.error(
          { err, profileId: profile.id },
          "Failed to send weekly digest for profile",
        );
        errors++;
      }
    }

    totalProfilesEmailed += profilesEmailed;
    totalErrors += errors;

    cursor = profiles.length === PROFILE_BATCH_SIZE
      ? profiles[profiles.length - 1]?.id
      : undefined;
  } while (cursor !== undefined);

  logger.info(
    { profilesEmailed: totalProfilesEmailed, errors: totalErrors },
    "Weekly digest run completed",
  );
}

const WEEKLY_DIGEST_JOB_NAME = "weekly-digest";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST_RETRY_DELAY_MS = 60 * 60 * 1000;

async function claimWeeklyDigestRun(
  prismaClient = prisma,
  now = new Date(),
): Promise<boolean> {
  const dueBefore = new Date(now.getTime() - SEVEN_DAYS_MS);
  const claimed = await prismaClient.$queryRaw<Array<{ name: string }>>(Prisma.sql`
    INSERT INTO "scheduler_jobs" ("name", "lastRunAt", "updatedAt")
    VALUES (${WEEKLY_DIGEST_JOB_NAME}, ${now}, ${now})
    ON CONFLICT ("name") DO UPDATE
      SET "lastRunAt" = EXCLUDED."lastRunAt", "updatedAt" = EXCLUDED."updatedAt"
      WHERE "scheduler_jobs"."lastRunAt" <= ${dueBefore}
    RETURNING "name"
  `);
  return claimed.length > 0;
}

/**
 * Hand a claim back when the run it covered never completed. Without this the
 * persisted "last run" would suppress the next attempt for a full week, silently
 * skipping the week's digest after a single early failure (#1349).
 *
 * The write is guarded on `lastRunAt` still holding the value we claimed with, so
 * a run that already handed off to a newer claim cannot roll that one back.
 */
async function releaseWeeklyDigestClaim(
  claimedAt: Date,
  prismaClient = prisma,
): Promise<boolean> {
  const result = await prismaClient.schedulerJob.updateMany({
    where: { name: WEEKLY_DIGEST_JOB_NAME, lastRunAt: claimedAt },
    data: { lastRunAt: new Date(0) },
  });
  return result.count > 0;
}

/**
 * Claim and run the weekly digest only if at least 7 days have elapsed since
 * the previous claim. If the run fails, the claim is released so the retry
 * (scheduled by the scheduler) is immediately due again.
 */
export async function maybeRunWeeklyDigest(
  prismaClient = prisma,
  sendDigests: typeof sendWeeklyDigests = sendWeeklyDigests,
): Promise<void> {
  const runAt = new Date();
  if (!(await claimWeeklyDigestRun(prismaClient, runAt))) {
    logger.info("Weekly digest skipped — not yet due or already claimed");
    return;
  }

  try {
    await sendDigests();
  } catch (err) {
    logger.error({ err }, "Weekly digest run failed — releasing claim so it can be retried");
    try {
      await releaseWeeklyDigestClaim(runAt, prismaClient);
    } catch (releaseErr) {
      logger.error({ err: releaseErr }, "Failed to release weekly digest claim");
    }
    throw err;
  }
}

let digestInterval: ReturnType<typeof setInterval> | null = null;
let digestRetryTimeout: ReturnType<typeof setTimeout> | null = null;

function clearDigestRetry(): void {
  if (digestRetryTimeout) {
    clearTimeout(digestRetryTimeout);
    digestRetryTimeout = null;
  }
}

export function startWeeklyDigestScheduler() {
  if (process.env.WEEKLY_DIGEST_ENABLED === "true") {
    logger.info("Weekly digest scheduler enabled. Starting...");

    const tick = () => {
      maybeRunWeeklyDigest().catch((err) => {
        logger.error({ err }, "Error in weekly digest run");
        // The claim was released, so the digest is due again — retry on a short
        // delay instead of waiting out the full weekly interval (#1349).
        if (digestRetryTimeout) return;
        digestRetryTimeout = setTimeout(() => {
          digestRetryTimeout = null;
          tick();
        }, DIGEST_RETRY_DELAY_MS);
        digestRetryTimeout.unref?.();
      });
    };

    // Check the persisted last-run time before firing so that a restart or
    // rolling deploy does not immediately re-send digests (#592).
    tick();

    digestInterval = setInterval(tick, SEVEN_DAYS_MS);
  } else {
    logger.info("Weekly digest scheduler disabled. Set WEEKLY_DIGEST_ENABLED=true to enable.");
  }
}

export function stopWeeklyDigestScheduler() {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
  clearDigestRetry();
}
