import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationPath = resolve(
  __dirname,
  "../prisma/migrations/20260924000000_add_milestone_reached_at/migration.sql",
);

test("Milestone.reachedAt migration file exists and contains expected DDL", () => {
  assert.equal(existsSync(migrationPath), true);

  const migration = readFileSync(migrationPath, "utf8");
  assert.match(migration, /ALTER TABLE "Milestone"\s+ADD COLUMN "reachedAt" TIMESTAMP\(3\);/);
  assert.match(migration, /CREATE INDEX "Milestone_profileId_status_reachedAt_idx"/);
  assert.match(migration, /"reachedAt" DESC/);
});

// Integration: apply the migration SQL against a disposable schema so we
// know the DDL is actually valid and deployable — not just plausible-looking
// text (#1554).
test("Milestone.reachedAt migration is deployable against a real database", async () => {
  const schema = `migration_test_${randomUUID().replace(/-/g, "_")}`;

  // Raw SQL helper that targets our disposable schema.
  const run = (sql: string) =>
    prisma.$executeRawUnsafe(sql);

  try {
    // Create an isolated schema so this test never touches production tables.
    await run(`CREATE SCHEMA "${schema}"`);
    await run(`SET search_path TO "${schema}"`);

    // Minimal table that the migration's ALTER TABLE targets.
    await run(`
      CREATE TABLE "${schema}"."Milestone" (
        "id"        TEXT        NOT NULL PRIMARY KEY,
        "profileId" TEXT        NOT NULL,
        "status"    TEXT        NOT NULL DEFAULT 'pending'
      )
    `);

    // Read and execute the actual migration SQL.
    const migrationSql = readFileSync(migrationPath, "utf8")
      // Qualify unquoted table names with the disposable schema so the
      // statements land in the right place.
      .replace(/ALTER TABLE "Milestone"/g, `ALTER TABLE "${schema}"."Milestone"`)
      .replace(/CREATE INDEX "Milestone_profileId_status_reachedAt_idx"\s+ON "Milestone"/,
        `CREATE INDEX "Milestone_profileId_status_reachedAt_idx" ON "${schema}"."Milestone"`);

    // Execute each statement individually (Prisma's $executeRawUnsafe does
    // not support multiple semicolon-separated statements in one call).
    const statements = migrationSql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);

    for (const stmt of statements) {
      await run(stmt);
    }

    // Verify the column and index actually exist in the information schema.
    const colRows: { column_name: string }[] = await prisma.$queryRawUnsafe(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = '${schema}'
        AND table_name   = 'Milestone'
        AND column_name  = 'reachedAt'
    `);
    assert.equal(colRows.length, 1, '"reachedAt" column should exist after migration');

    const idxRows: { indexname: string }[] = await prisma.$queryRawUnsafe(`
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = '${schema}'
        AND tablename  = 'Milestone'
        AND indexname  = 'Milestone_profileId_status_reachedAt_idx'
    `);
    assert.equal(idxRows.length, 1, "compound index should exist after migration");
  } finally {
    // Always clean up the disposable schema, even if the test fails.
    await run(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }
});
