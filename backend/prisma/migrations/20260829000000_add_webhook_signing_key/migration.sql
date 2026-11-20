-- Migration: add signingKey column to Webhook table
--
-- Context: secretHash was documented as a hash but was actually storing the
-- raw plaintext secret (issue #1029). This migration adds a separate
-- signingKey column that holds the raw signing secret used for HMAC delivery.
-- secretHash will now store a real SHA-256 hash of the raw secret.
--
-- Existing rows: signingKey is backfilled with the current secretHash value
-- (which is currently plaintext) so that deliveries for existing webhooks
-- continue to work without interruption. Operators should rotate all existing
-- webhook secrets after deploying this migration.

ALTER TABLE "Webhook" ADD COLUMN "signingKey" TEXT;

-- Backfill: copy current plaintext secretHash into signingKey for existing rows
UPDATE "Webhook" SET "signingKey" = "secretHash";

-- Make the column non-nullable now that all rows have a value
ALTER TABLE "Webhook" ALTER COLUMN "signingKey" SET NOT NULL;
