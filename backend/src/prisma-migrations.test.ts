import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  __dirname,
  "../prisma/migrations/20260924000000_add_milestone_reached_at/migration.sql",
);

test("Milestone.reachedAt has a deployable Prisma migration", () => {
  assert.equal(existsSync(migrationPath), true);

  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /ALTER TABLE "Milestone"\s+ADD COLUMN "reachedAt" TIMESTAMP\(3\);/);
  assert.match(migration, /CREATE INDEX "Milestone_profileId_status_reachedAt_idx"/);
  assert.match(migration, /"reachedAt" DESC/);
});
