import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { claimScheduledJob, releaseScheduledJobClaim } from "./scheduler-claim.js";

const RETENTION_PURGE_JOB_NAME = "ip-retention-purge";
const REVOKED_TOKEN_PURGE_JOB_NAME = "revoked-token-purge";
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REVOKED_TOKEN_PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Null out reporterIp on any ProfileReport past its retention window
 * (expiresAt). The report itself (reason/details/profileId) is kept for
 * moderation history — only the IP address is privacy-sensitive (#870).
 */
export async function purgeExpiredReporterIps(prismaClient = prisma, now = new Date()) {
  const result = await prismaClient.profileReport.updateMany({
    where: {
      expiresAt: { lte: now },
      reporterIp: { not: null },
    },
    data: { reporterIp: null },
  });

  if (result.count > 0) {
    logger.info({ purged: result.count }, "Purged expired reporter IPs");
  }

  return result.count;
}

export async function purgeExpiredRevokedTokens(prismaClient = prisma, now = new Date()) {
  const result = await prismaClient.revokedToken.deleteMany({
    where: { expiresAt: { lte: now } },
  });

  if (result.count > 0) {
    logger.info({ purged: result.count }, "Purged expired revoked tokens");
  }

  return result.count;
}

async function maybeRunPurge(): Promise<void> {
  const runAt = new Date();

  if (!(await claimScheduledJob(RETENTION_PURGE_JOB_NAME, PURGE_INTERVAL_MS, prisma, runAt))) {
    logger.debug("IP retention purge skipped — not yet due or already claimed");
    return;
  }

  try {
    await purgeExpiredReporterIps();
  } catch (err) {
    await releaseScheduledJobClaim(RETENTION_PURGE_JOB_NAME, runAt).catch((releaseErr) => {
      logger.error({ err: releaseErr }, "Failed to release IP retention purge claim");
    });
    throw err;
  }
}

async function maybeRunRevokedTokenPurge(): Promise<void> {
  const runAt = new Date();

  if (
    !(await claimScheduledJob(
      REVOKED_TOKEN_PURGE_JOB_NAME,
      REVOKED_TOKEN_PURGE_INTERVAL_MS,
      prisma,
      runAt,
    ))
  ) {
    logger.debug("Revoked token purge skipped — not yet due or already claimed");
    return;
  }

  try {
    await purgeExpiredRevokedTokens();
  } catch (err) {
    await releaseScheduledJobClaim(REVOKED_TOKEN_PURGE_JOB_NAME, runAt).catch((releaseErr) => {
      logger.error({ err: releaseErr }, "Failed to release revoked token purge claim");
    });
    throw err;
  }
}

let purgeInterval: ReturnType<typeof setInterval> | null = null;
let revokedTokenPurgeInterval: ReturnType<typeof setInterval> | null = null;

export function startIpRetentionPurgeScheduler() {
  if (purgeInterval) return;
  logger.info("IP retention purge scheduler starting...");

  maybeRunPurge().catch((err) => {
    logger.error({ err }, "Error in initial maybeRunPurge check");
  });

  purgeInterval = setInterval(() => {
    maybeRunPurge().catch((err) => {
      logger.error({ err }, "Error in maybeRunPurge interval");
    });
  }, PURGE_INTERVAL_MS);
}

export function startRevokedTokenPurgeScheduler() {
  if (revokedTokenPurgeInterval) return;
  logger.info("Revoked token purge scheduler starting...");

  maybeRunRevokedTokenPurge().catch((err) => {
    logger.error({ err }, "Error in initial maybeRunRevokedTokenPurge check");
  });

  revokedTokenPurgeInterval = setInterval(() => {
    maybeRunRevokedTokenPurge().catch((err) => {
      logger.error({ err }, "Error in maybeRunRevokedTokenPurge interval");
    });
  }, REVOKED_TOKEN_PURGE_INTERVAL_MS);
}

export function stopIpRetentionPurgeScheduler() {
  if (purgeInterval) {
    clearInterval(purgeInterval);
    purgeInterval = null;
  }
}

export function stopRevokedTokenPurgeScheduler() {
  if (revokedTokenPurgeInterval) {
    clearInterval(revokedTokenPurgeInterval);
    revokedTokenPurgeInterval = null;
  }
}
