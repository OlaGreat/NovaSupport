import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  checkAndAwardBadges,
  sweepBadges,
  maybeRunBadgeSweep,
  BADGE_SWEEP_JOB_NAME,
} from "./badge-awarder.js";

const ALL_BADGES = [
  { id: "b-first", criteria: "first_support", name: "First Supporter" },
  { id: "b-ten", criteria: "ten_supporters", name: "10 Supporters" },
  { id: "b-xlm", criteria: "total_100_xlm", name: "100 XLM Club" },
  { id: "b-milestone", criteria: "milestone_reached", name: "Milestone Maker" },
];

function buildPrismaMock(overrides: {
  badges?: unknown[];
  existingAwards?: { badgeId: string }[];
  txCount?: number;
  uniqueSupporters?: { supporterAddress: string }[];
  totalsByAsset?: { assetCode: string; assetIssuer: string | null; _sum: { amount: unknown } }[];
  milestonesReached?: number;
  createImpl?: () => Promise<unknown>;
} = {}) {
  const profileBadgeCreate = mock.fn(overrides.createImpl ?? (() => Promise.resolve({})));

  const tx = {
    $executeRaw: mock.fn(() => Promise.resolve()),
    badge: {
      findMany: mock.fn(() => Promise.resolve(overrides.badges ?? ALL_BADGES)),
    },
    profileBadge: {
      findMany: mock.fn(() => Promise.resolve(overrides.existingAwards ?? [])),
      create: profileBadgeCreate,
    },
    supportTransaction: {
      count: mock.fn(() => Promise.resolve(overrides.txCount ?? 0)),
      findMany: mock.fn(() => Promise.resolve(overrides.uniqueSupporters ?? [])),
      groupBy: mock.fn(() => Promise.resolve(overrides.totalsByAsset ?? [])),
    },
    milestone: {
      count: mock.fn(() => Promise.resolve(overrides.milestonesReached ?? 0)),
    },
  };

  const $transaction = mock.fn((cb: (tx: unknown) => Promise<void>) => cb(tx));

  return { $transaction, tx, profileBadgeCreate };
}

function awardedCriteria(profileBadgeCreate: ReturnType<typeof mock.fn>): string[] {
  return profileBadgeCreate.mock.calls.map((c) => {
    const badgeId = (c.arguments[0] as { data: { badgeId: string } }).data.badgeId;
    return ALL_BADGES.find((b) => b.id === badgeId)?.criteria ?? badgeId;
  });
}

test("first_support is awarded when txCount >= 1", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[0]],
    txCount: 1,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.deepEqual(awardedCriteria(profileBadgeCreate), ["first_support"]);
});

test("first_support is NOT awarded when txCount is 0", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[0]],
    txCount: 0,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.equal(profileBadgeCreate.mock.calls.length, 0);
});

test("ten_supporters is awarded when uniqueSupporters.length >= 10", async () => {
  const supporters = Array.from({ length: 10 }, (_, i) => ({ supporterAddress: `G${i}` }));
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[1]],
    uniqueSupporters: supporters,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.deepEqual(awardedCriteria(profileBadgeCreate), ["ten_supporters"]);
});

test("ten_supporters is NOT awarded when uniqueSupporters.length < 10", async () => {
  const supporters = Array.from({ length: 9 }, (_, i) => ({ supporterAddress: `G${i}` }));
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[1]],
    uniqueSupporters: supporters,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.equal(profileBadgeCreate.mock.calls.length, 0);
});

test("total_100_xlm is awarded for XLM totals >= 100, ignoring USDC", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[2]],
    totalsByAsset: [
      { assetCode: "XLM", assetIssuer: null, _sum: { amount: 150 } },
      { assetCode: "USDC", assetIssuer: "GISSUER", _sum: { amount: 100000 } },
    ],
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.deepEqual(awardedCriteria(profileBadgeCreate), ["total_100_xlm"]);
});

test("total_100_xlm is NOT awarded from USDC totals alone", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[2]],
    totalsByAsset: [
      { assetCode: "USDC", assetIssuer: "GISSUER", _sum: { amount: 100000 } },
    ],
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.equal(profileBadgeCreate.mock.calls.length, 0);
});

test("milestone_reached is awarded when at least one milestone is reached", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[3]],
    milestonesReached: 1,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.deepEqual(awardedCriteria(profileBadgeCreate), ["milestone_reached"]);
});

test("already-awarded badge is not re-awarded, and a P2002 race is silently ignored", async () => {
  const { $transaction, profileBadgeCreate } = buildPrismaMock({
    badges: [ALL_BADGES[0]],
    existingAwards: [{ badgeId: "b-first" }],
    txCount: 5,
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.equal(profileBadgeCreate.mock.calls.length, 0);

  const p2002Error = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  const { $transaction: tx2, profileBadgeCreate: create2 } = buildPrismaMock({
    badges: [ALL_BADGES[0]],
    txCount: 1,
    createImpl: () => Promise.reject(p2002Error),
  });
  await assert.doesNotReject(() => checkAndAwardBadges("profile-1", { $transaction: tx2 } as any));
  assert.equal(create2.mock.calls.length, 1);
});

test("all badges already awarded returns early without checking any criteria", async () => {
  const { $transaction, tx, profileBadgeCreate } = buildPrismaMock({
    badges: ALL_BADGES,
    existingAwards: ALL_BADGES.map((b) => ({ badgeId: b.id })),
  });
  await checkAndAwardBadges("profile-1", { $transaction } as any);
  assert.equal(profileBadgeCreate.mock.calls.length, 0);
  assert.equal((tx.supportTransaction.count as ReturnType<typeof mock.fn>).mock.calls.length, 0);
});

// ── issue #1354: periodic sweep safety net ────────────────────────────────────

function buildSweepPrismaMock(profileBatches: string[][]) {
  let call = 0;
  const findMany = mock.fn(() => {
    const ids = profileBatches[call] ?? [];
    call += 1;
    return Promise.resolve(ids.map((id) => ({ id })));
  });
  return { prismaClient: { profile: { findMany } }, findMany };
}

test("sweepBadges re-checks every profile with support activity", async () => {
  const { prismaClient, findMany } = buildSweepPrismaMock([["p-1", "p-2"]]);
  const checked: string[] = [];
  const checkFn = mock.fn((id: string) => {
    checked.push(id);
    return Promise.resolve();
  });

  const swept = await sweepBadges(prismaClient as never, checkFn as never);

  assert.equal(swept, 2);
  assert.deepEqual(checked, ["p-1", "p-2"]);
  assert.equal(findMany.mock.calls.length, 1);
});

test("sweepBadges only considers profiles with a SUCCESS support transaction", async () => {
  const { prismaClient, findMany } = buildSweepPrismaMock([[]]);

  await sweepBadges(prismaClient as never, mock.fn(() => Promise.resolve()) as never);

  const [args] = findMany.mock.calls[0]!.arguments as unknown as [
    { where: { supportTransactions: { some: { status: { not: string } } } } },
  ];
  assert.equal(args.where.supportTransactions.some.status, "SUCCESS");
});

test("sweepBadges pages through profiles using a cursor when a batch is full", async () => {
  const firstBatch = Array.from({ length: 100 }, (_, i) => `p-${i}`);
  const { prismaClient, findMany } = buildSweepPrismaMock([firstBatch, ["p-100"]]);
  const checkFn = mock.fn(() => Promise.resolve());

  const swept = await sweepBadges(prismaClient as never, checkFn as never);

  assert.equal(swept, 101);
  assert.equal(findMany.mock.calls.length, 2);
  const secondCall = (findMany.mock.calls[1]!.arguments as unknown as Array<{
    cursor?: { id: string };
    skip?: number;
  }>)[0]!;
  assert.deepEqual(secondCall.cursor, { id: "p-99" });
  assert.equal(secondCall.skip, 1);
});

test("sweepBadges is a no-op when no profile has support activity", async () => {
  const { prismaClient, findMany } = buildSweepPrismaMock([[]]);
  const checkFn = mock.fn(() => Promise.resolve());

  const swept = await sweepBadges(prismaClient as never, checkFn as never);

  assert.equal(swept, 0);
  assert.equal(checkFn.mock.calls.length, 0);
  assert.equal(findMany.mock.calls.length, 1);
});

type BadgeSweepPrismaMock = {
  prismaClient: {
    $queryRaw: ReturnType<typeof mock.fn>;
    schedulerJob: { updateMany: ReturnType<typeof mock.fn> };
  };
  queryRaw: ReturnType<typeof mock.fn>;
  updateMany: ReturnType<typeof mock.fn>;
};

function buildBadgeSweepPrismaMock(options: { claimed?: boolean } = {}): BadgeSweepPrismaMock {
  const queryRaw = mock.fn(() =>
    Promise.resolve(options.claimed === false ? [] : [{ name: BADGE_SWEEP_JOB_NAME }]),
  );
  const updateMany = mock.fn(() => Promise.resolve({ count: 1 }));
  return {
    prismaClient: { $queryRaw: queryRaw, schedulerJob: { updateMany } },
    queryRaw,
    updateMany,
  };
}

test("maybeRunBadgeSweep runs the sweep when the claim is won", async () => {
  const { prismaClient, updateMany } = buildBadgeSweepPrismaMock();
  const sweep = mock.fn(() => Promise.resolve(3));

  await maybeRunBadgeSweep(prismaClient as never, sweep as never);

  assert.equal(sweep.mock.calls.length, 1);
  assert.equal(updateMany.mock.calls.length, 0, "a completed sweep must keep its claim");
});

test("maybeRunBadgeSweep skips the sweep when the claim is lost", async () => {
  const { prismaClient, updateMany } = buildBadgeSweepPrismaMock({ claimed: false });
  const sweep = mock.fn(() => Promise.resolve(0));

  await maybeRunBadgeSweep(prismaClient as never, sweep as never);

  assert.equal(sweep.mock.calls.length, 0);
  assert.equal(updateMany.mock.calls.length, 0);
});

test("maybeRunBadgeSweep releases its claim when the sweep fails", async () => {
  const { prismaClient, updateMany } = buildBadgeSweepPrismaMock();
  const sweep = mock.fn(() => Promise.reject(new Error("db down")));

  await assert.rejects(() => maybeRunBadgeSweep(prismaClient as never, sweep as never));

  assert.equal(updateMany.mock.calls.length, 1);
  const [args] = updateMany.mock.calls[0]!.arguments as [
    { where: { name: string }; data: { lastRunAt: Date } },
  ];
  assert.equal(args.where.name, BADGE_SWEEP_JOB_NAME);
  assert.ok(args.data.lastRunAt.getTime() < Date.now());
});
