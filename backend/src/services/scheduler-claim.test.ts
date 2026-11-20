import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { claimScheduledJob, releaseScheduledJobClaim } from "./scheduler-claim.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function buildPrismaMock(options: { claimed?: boolean } = {}) {
  const queryRaw = mock.fn(() =>
    Promise.resolve(options.claimed === false ? [] : [{ name: "ip-retention-purge" }]),
  );
  const updateMany = mock.fn(() => Promise.resolve({ count: 1 }));
  return {
    prismaClient: { $queryRaw: queryRaw, schedulerJob: { updateMany } },
    queryRaw,
    updateMany,
  };
}

test("claim succeeds when the job row is due", async () => {
  const { prismaClient, queryRaw } = buildPrismaMock();

  const claimed = await claimScheduledJob("ip-retention-purge", DAY_MS, prismaClient as unknown as Parameters<typeof claimScheduledJob>[2]);

  assert.equal(claimed, true);
  assert.equal(queryRaw.mock.calls.length, 1);
});

test("claim fails when another replica already holds the claim", async () => {
  const { prismaClient } = buildPrismaMock({ claimed: false });

  const claimed = await claimScheduledJob("ip-retention-purge", DAY_MS, prismaClient as unknown as Parameters<typeof claimScheduledJob>[2]);

  assert.equal(claimed, false);
});

test("the claim is a single conditional upsert, not a read-then-write", async () => {
  const { prismaClient, queryRaw } = buildPrismaMock();

  await claimScheduledJob("revoked-token-purge", DAY_MS, prismaClient as unknown as Parameters<typeof claimScheduledJob>[2]);

  const sqlText = (queryRaw.mock.calls[0]!.arguments[0] as { strings: string[] }).strings.join("?");
  assert.match(sqlText, /ON CONFLICT \("name"\) DO UPDATE/);
  assert.match(sqlText, /WHERE "scheduler_jobs"\."lastRunAt" <=/);
  // No separate findUnique/read may precede the write.
  assert.equal((prismaClient as unknown as Parameters<typeof claimScheduledJob>[2]).schedulerJob.findUnique, undefined);
});

test("releasing a claim rewinds lastRunAt so the job is due again", async () => {
  const { prismaClient, updateMany } = buildPrismaMock();
  const claimedAt = new Date("2026-07-27T00:00:00Z");

  await releaseScheduledJobClaim("ip-retention-purge", claimedAt, prismaClient as unknown as Parameters<typeof claimScheduledJob>[2]);

  const [args] = updateMany.mock.calls[0]!.arguments as [{ where: unknown; data: { lastRunAt: Date } }];
  assert.equal((args.where as { name: string }).name, "ip-retention-purge");
  assert.deepEqual((args.where as { lastRunAt: Date }).lastRunAt, claimedAt);
  assert.ok(args.data.lastRunAt.getTime() < claimedAt.getTime());
});
