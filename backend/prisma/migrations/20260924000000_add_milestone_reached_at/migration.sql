ALTER TABLE "Milestone"
ADD COLUMN "reachedAt" TIMESTAMP(3);

CREATE INDEX "Milestone_profileId_status_reachedAt_idx"
ON "Milestone"("profileId", "status", "reachedAt" DESC);
