import { prisma } from "../db.js";
import { sendEmail } from "../mailer.js";
import { logger } from "../logger.js";
import { escapeHtml } from "./email.js";

const PROFILE_BATCH_SIZE = 100;

export async function sendWeeklyDigests(prismaClient = prisma) {
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
      try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

        const [transactions, uniqueSupporters, milestonesReached, assetGroups] = await Promise.all([
          prismaClient.supportTransaction.findMany({
            where: {
              profileId: profile.id,
              status: { not: "failed" },
              createdAt: { gte: sevenDaysAgo },
            },
            orderBy: { createdAt: "desc" },
          }),
          prismaClient.supportTransaction.findMany({
            where: {
              profileId: profile.id,
              supporterAddress: { not: null },
              status: { not: "failed" },
              createdAt: { gte: sevenDaysAgo },
            },
            distinct: ["supporterAddress"],
            select: { supporterAddress: true },
          }),
          prismaClient.milestone.findMany({
            where: {
              profileId: profile.id,
              status: "reached",
              updatedAt: { gte: sevenDaysAgo },
            },
          }),
          prismaClient.supportTransaction.groupBy({
            by: ["assetCode"],
            where: {
              profileId: profile.id,
              status: { not: "failed" },
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

        await sendEmail({
          to: profile.email!,
          subject: "Your NovaSupport weekly recap",
          text,
          html,
        });

        profilesEmailed++;
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

/**
 * Read the persisted last-run timestamp from the database.
 * Returns null when no record exists (i.e. the job has never run).
 */
async function getLastDigestRunAt(): Promise<Date | null> {
  const row = await prisma.schedulerJob.findUnique({
    where: { name: WEEKLY_DIGEST_JOB_NAME },
  });
  return row?.lastRunAt ?? null;
}

/**
 * Persist the current time as the last-run timestamp for the weekly digest.
 * Called immediately after a successful digest run so that a subsequent
 * process restart does not re-fire the job prematurely (#592).
 */
async function markDigestRunAt(at: Date): Promise<void> {
  await prisma.schedulerJob.upsert({
    where: { name: WEEKLY_DIGEST_JOB_NAME },
    create: { name: WEEKLY_DIGEST_JOB_NAME, lastRunAt: at },
    update: { lastRunAt: at },
  });
}

/**
 * Run the weekly digest only if at least 7 days have elapsed since the last
 * successful run. Guards against re-firing on every process restart (#592).
 */
async function maybeRunWeeklyDigest(): Promise<void> {
  const lastRunAt = await getLastDigestRunAt();
  const now = Date.now();

  if (lastRunAt !== null && now - lastRunAt.getTime() < SEVEN_DAYS_MS) {
    const msUntilDue = SEVEN_DAYS_MS - (now - lastRunAt.getTime());
    const hoursUntilDue = Math.ceil(msUntilDue / (60 * 60 * 1000));
    logger.info(
      { lastRunAt, hoursUntilDue },
      "Weekly digest skipped — not yet due",
    );
    return;
  }

  const runAt = new Date(now);
  await sendWeeklyDigests();
  await markDigestRunAt(runAt);
}

let digestInterval: ReturnType<typeof setInterval> | null = null;

export function startWeeklyDigestScheduler() {
  if (process.env.WEEKLY_DIGEST_ENABLED === "true") {
    logger.info("Weekly digest scheduler enabled. Starting...");

    // Check the persisted last-run time before firing so that a restart or
    // rolling deploy does not immediately re-send digests (#592).
    maybeRunWeeklyDigest().catch((err) => {
      logger.error({ err }, "Error in initial maybeRunWeeklyDigest check");
    });

    digestInterval = setInterval(() => {
      maybeRunWeeklyDigest().catch((err) => {
        logger.error({ err }, "Error in maybeRunWeeklyDigest interval");
      });
    }, SEVEN_DAYS_MS);
  } else {
    logger.info("Weekly digest scheduler disabled. Set WEEKLY_DIGEST_ENABLED=true to enable.");
  }
}

export function stopWeeklyDigestScheduler() {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
}
