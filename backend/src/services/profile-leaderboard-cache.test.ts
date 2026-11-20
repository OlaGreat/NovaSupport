import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getCachedLeaderboard,
  setCachedLeaderboard,
  invalidateProfileLeaderboardCache,
  applyLeaderboardInvalidationBroadcast,
} from "./profile-leaderboard-cache.js";
import { getIsRedisAvailable, getRedisClient, getRedisSubscriber } from "./redis.js";
import type { LeaderboardResponse } from "./profile-leaderboard-cache.js";

// These tests exercise the in-process fallback path (no REDIS_URL configured),
// which is the cache an invalidation broadcast has to reach across replicas.

function response(sort: "total_amount" | "transaction_count" = "total_amount"): LeaderboardResponse {
  return {
    leaderboard: [
      {
        rank: 1,
        supporterAddress: "GABC",
        assetCode: "XLM",
        totalAmount: "100",
        transactionCount: 2,
      },
    ],
    total: 1,
    limit: 10,
    offset: 0,
    sort,
  };
}

test("precondition: tests run without Redis so the fallback cache is used", () => {
  assert.equal(getIsRedisAvailable(), false);
  assert.equal(getRedisClient(), null);
  assert.equal(getRedisSubscriber(), null);
});

test("the fallback cache serves a value that was just written", async () => {
  await setCachedLeaderboard("lb-a", 10, 0, "total_amount", response());
  assert.deepEqual(await getCachedLeaderboard("lb-a", 10, 0, "total_amount"), response());
});

test("an invalidation broadcast from another replica drops this replica's fallback entry", async () => {
  await setCachedLeaderboard("lb-b", 10, 0, "total_amount", response());
  assert.ok(await getCachedLeaderboard("lb-b", 10, 0, "total_amount"));

  applyLeaderboardInvalidationBroadcast("lb-b");

  assert.equal(await getCachedLeaderboard("lb-b", 10, 0, "total_amount"), null);
});

test("a broadcast only clears the profile it names", async () => {
  await setCachedLeaderboard("lb-c", 10, 0, "total_amount", response());
  await setCachedLeaderboard("lb-d", 10, 0, "total_amount", response());

  applyLeaderboardInvalidationBroadcast("lb-c");

  assert.equal(await getCachedLeaderboard("lb-c", 10, 0, "total_amount"), null);
  assert.ok(await getCachedLeaderboard("lb-d", 10, 0, "total_amount"));
});

test("a broadcast covers every sort/page variant of that profile", async () => {
  await setCachedLeaderboard("lb-e", 10, 0, "total_amount", response());
  await setCachedLeaderboard("lb-e", 10, 0, "transaction_count", response("transaction_count"));
  await setCachedLeaderboard("lb-e", 25, 25, "total_amount", response());

  applyLeaderboardInvalidationBroadcast("lb-e");

  assert.equal(await getCachedLeaderboard("lb-e", 10, 0, "total_amount"), null);
  assert.equal(await getCachedLeaderboard("lb-e", 10, 0, "transaction_count"), null);
  assert.equal(await getCachedLeaderboard("lb-e", 25, 25, "total_amount"), null);
});

test("a broadcast with an empty profile id is ignored", async () => {
  await setCachedLeaderboard("lb-f", 10, 0, "total_amount", response());

  applyLeaderboardInvalidationBroadcast("");

  assert.ok(await getCachedLeaderboard("lb-f", 10, 0, "total_amount"));
});

test("invalidation with no Redis still clears the local fallback cache", async () => {
  await setCachedLeaderboard("lb-g", 10, 0, "total_amount", response());

  await invalidateProfileLeaderboardCache("lb-g");

  assert.equal(await getCachedLeaderboard("lb-g", 10, 0, "total_amount"), null);
});
