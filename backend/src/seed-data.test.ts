import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import test from "node:test";

const __dirname = dirname(fileURLToPath(import.meta.url));
const seedScript = readFileSync(resolve(__dirname, "../prisma/seed.ts"), "utf8");

test("seeded support transaction uses the confirmed-success status", () => {
  // Analytics, leaderboard, and badge queries filter on status "SUCCESS".
  const transactionSeed = seedScript.slice(seedScript.indexOf("prisma.supportTransaction.upsert"));
  const status = transactionSeed.match(/status:\s*"([^"]+)"/)?.[1];

  assert.equal(status, "SUCCESS");
});
