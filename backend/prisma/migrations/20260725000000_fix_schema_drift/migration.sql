-- Fix schema drift detected by `prisma migrate diff`.
-- Brings the migration state in sync with the current schema.prisma.

-- 1. Webhook: rename column `secret` → `secretHash` to match schema
ALTER TABLE "Webhook" RENAME COLUMN "secret" TO "secretHash";

-- 2. AcceptedAsset: add unique constraint matching @@unique([profileId, code, issuer])
ALTER TABLE "AcceptedAsset"
  ADD CONSTRAINT "AcceptedAsset_profileId_code_issuer_key"
  UNIQUE ("profileId", "code", "issuer");

-- 3. Profile: add unique constraint on walletAddress (schema has @unique)
ALTER TABLE "Profile"
  ADD CONSTRAINT "Profile_walletAddress_key"
  UNIQUE ("walletAddress");

-- 4. SupportTransaction: recreate FK with ON DELETE RESTRICT (schema changed from CASCADE)
ALTER TABLE "SupportTransaction"
  DROP CONSTRAINT "SupportTransaction_profileId_fkey";

ALTER TABLE "SupportTransaction"
  ADD CONSTRAINT "SupportTransaction_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "Profile"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
