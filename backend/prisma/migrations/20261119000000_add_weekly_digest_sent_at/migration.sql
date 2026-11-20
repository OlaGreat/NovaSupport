-- #1499: per-profile completion marker for the weekly digest, so a retried run
-- skips profiles it already emailed.
ALTER TABLE "NotificationPreferences" ADD COLUMN "lastWeeklyDigestSentAt" TIMESTAMP(3);
