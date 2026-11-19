import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const dir = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(resolve(dir, rel), "utf8");

const seed = read("../prisma/seed.ts");
const analytics = read("./analytics.ts");
const badgeAwarder = read("./services/badge-awarder.ts");

// Every real analytics/leaderboard/badge query filters on one exact status
// string. Derive it from analytics.ts's raw SQL so this test tracks the source
// of truth instead of hardcoding the value.
function confirmedSuccessStatus() {
  const match = analytics.match(/AND "status" = '([^']+)'/);
  assert.ok(match, "analytics.ts must define its confirmed-success filter in raw SQL");
  return match[1];
}

test("seeded support transaction uses the exact confirmed-success status every query filters on", () => {
  const expected = confirmedSuccessStatus();

  // Independent consumers must agree on that same value.
  assert.match(
    badgeAwarder,
    new RegExp(`status: "${expected}"`),
    "badge-awarder.ts must filter on the same confirmed-success status",
  );

  // The seed script's only SupportTransaction must be a confirmed-success one,
  // or fresh dev setups populate nothing that analytics/leaderboards/badges read.
  const seedStatus = seed.match(/status:\s*"([^"]+)"/);
  assert.ok(seedStatus, "seed.ts must set an explicit status on the seeded transaction");
  assert.equal(
    seedStatus[1],
    expected,
    "seeded transaction status must match the confirmed-success status used by analytics/leaderboard/badge queries",
  );
});
