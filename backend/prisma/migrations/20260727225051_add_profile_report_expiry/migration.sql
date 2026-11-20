/*
  Warnings:

  - Added the required column `expiresAt` to the `profile_reports` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "profile_reports" ADD COLUMN "expiresAt" TIMESTAMP(3),
ALTER COLUMN "reporterIp" DROP NOT NULL;

-- Backfill: set expiresAt to 90 days after creation for existing rows
UPDATE "profile_reports" SET "expiresAt" = "createdAt" + interval '90 days' WHERE "expiresAt" IS NULL;

-- Make the column non-nullable now that all rows have a value
ALTER TABLE "profile_reports" ALTER COLUMN "expiresAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "profile_reports_expiresAt_idx" ON "profile_reports"("expiresAt");
