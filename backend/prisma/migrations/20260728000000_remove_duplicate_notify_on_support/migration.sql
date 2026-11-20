-- Migration: Remove duplicate Profile.notifyOnSupport field
-- Issue #867: Profile.notifyOnSupport duplicates NotificationPreferences.notifyOnSupport

-- Step 1: Create NotificationPreferences for profiles that don't have one yet,
-- using the Profile.notifyOnSupport value
INSERT INTO "NotificationPreferences" ("id", "profileId", "notifyOnSupport", "notifyOnMilestone", "weeklyDigest", "createdAt", "updatedAt")
SELECT 
  gen_random_uuid()::text AS "id",
  p.id AS "profileId",
  p."notifyOnSupport",
  true AS "notifyOnMilestone",
  false AS "weeklyDigest",
  NOW() AS "createdAt",
  NOW() AS "updatedAt"
FROM "Profile" p
WHERE NOT EXISTS (
  SELECT 1 FROM "NotificationPreferences" np WHERE np."profileId" = p.id
);

-- Step 2: Update existing NotificationPreferences to match Profile.notifyOnSupport
-- in case they diverged
UPDATE "NotificationPreferences" np
SET 
  "notifyOnSupport" = p."notifyOnSupport",
  "updatedAt" = NOW()
FROM "Profile" p
WHERE np."profileId" = p.id
  AND np."notifyOnSupport" != p."notifyOnSupport";

-- Step 3: Remove the duplicate field from Profile
ALTER TABLE "Profile" DROP COLUMN "notifyOnSupport";
