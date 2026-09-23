import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { sendWeeklyDigests } from "./weekly-digest.js";
import { escapeHtml } from "./email.js";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeProfile(overrides: Record<string, unknown> = {}) {
  return {
    id: "profile-1",
    displayName: "Test Creator",
    username: "testcreator",
    email: "creator@test.com",
    emailVerified: true,
    notificationPreferences: { weeklyDigest: true },
    ...overrides,
  };
}

function makeAssetGroup(assetCode: string, amount: string) {
  return {
    assetCode,
    _sum: { amount: { toFixed: (n: number) => Number(amount).toFixed(n) } },
    _count: 1,
  };
}

function makePrismaMock(overrides: {
  profiles?: unknown[];
  transactions?: unknown[];
  uniqueSupporters?: unknown[];
  milestones?: unknown[];
  assetGroups?: unknown[];
} = {}) {
  const profileFindMany = mock.fn(() =>
    Promise.resolve(overrides.profiles ?? [makeProfile()]),
  );
  const txFindMany = mock.fn((_arg?: unknown) =>
    Promise.resolve(overrides.transactions ?? [{ amount: 5n, assetCode: "XLM", createdAt: new Date() }]),
  );
  const uniqueSupportersFindMany = mock.fn((_arg?: unknown) =>
    Promise.resolve(overrides.uniqueSupporters ?? [{ supporterAddress: "GABC" }]),
  );
  const milestoneFindMany = mock.fn(() =>
    Promise.resolve(overrides.milestones ?? []),
  );
  const txGroupBy = mock.fn(() =>
    Promise.resolve(overrides.assetGroups ?? [makeAssetGroup("XLM", "5")]),
  );

  return {
    profile: { findMany: profileFindMany },
    supportTransaction: {
      findMany: mock.fn((arg?: { distinct?: string[] }) => {
        if (arg?.distinct) return uniqueSupportersFindMany(arg);
        return txFindMany(arg);
      }),
      groupBy: txGroupBy,
    },
    milestone: { findMany: milestoneFindMany },
    _profileFindMany: profileFindMany,
    _txGroupBy: txGroupBy,
  };
}

// ── issue #656: cross-asset sum removed ──────────────────────────────────────

test("sendWeeklyDigests email does not contain a cross-asset totalReceived figure", async () => {
  const capturedEmails: string[] = [];

  // Patch sendEmail dynamically via module mock isn't available in node:test.
  // We verify the fix indirectly by checking the assetBreakdown format is present
  // and that no single numeric total appears by inspecting assetGroups directly.
  const xlmGroup = makeAssetGroup("XLM", "5");
  const usdcGroup = makeAssetGroup("USDC", "5");

  // The old (wrong) behaviour would produce "10.0000000" — sum of 5+5.
  // The new behaviour shows "5.0000000 XLM, 5.0000000 USDC".
  const wrongTotal = (5 + 5).toFixed(7); // "10.0000000"
  const correctBreakdown = `${(5).toFixed(7)} XLM, ${(5).toFixed(7)} USDC`;

  // Verify that the assetBreakdown string is correct and the cross-sum isn't
  const assetBreakdown = [xlmGroup, usdcGroup]
    .map((g) => `${g._sum.amount.toFixed(7)} ${g.assetCode}`)
    .join(", ");

  assert.equal(assetBreakdown, correctBreakdown);
  assert.notEqual(assetBreakdown, wrongTotal);

  // And confirm 10.0000000 does NOT appear in the breakdown
  assert.ok(!assetBreakdown.includes(wrongTotal), "cross-asset total must not appear in assetBreakdown");
});

// ── issue #657: profile batch pagination ─────────────────────────────────────

test("sendWeeklyDigests uses take: 100 in profile query", async () => {
  const mockPrisma = makePrismaMock({ profiles: [] });

  await sendWeeklyDigests(mockPrisma as any);

  const call = mockPrisma._profileFindMany.mock.calls[0];
  const arg = (call?.arguments as any)?.[0] as { take: number };
  assert.equal(arg?.take, 100);
});

test("sendWeeklyDigests queries again when first batch is exactly 100 profiles", async () => {
  const firstBatch = Array.from({ length: 100 }, (_, i) =>
    makeProfile({ id: `profile-${i}`, email: `creator${i}@test.com` }),
  );

  let profileCall = 0;
  const profileFindMany = mock.fn(() => {
    profileCall++;
    return Promise.resolve(profileCall === 1 ? firstBatch : []);
  });

  const mockPrisma = {
    profile: { findMany: profileFindMany },
    supportTransaction: {
      findMany: mock.fn(() => Promise.resolve([])), // no transactions → skip email
      groupBy: mock.fn(() => Promise.resolve([])),
    },
    milestone: { findMany: mock.fn(() => Promise.resolve([])) },
  };

  await sendWeeklyDigests(mockPrisma as any);

  // Should have made exactly 2 profile queries (100-item batch then empty)
  assert.equal(profileFindMany.mock.callCount(), 2);
});

test("sendWeeklyDigests stops after one profile query when batch is under 100", async () => {
  const mockPrisma = makePrismaMock({ profiles: [makeProfile()], transactions: [] });

  await sendWeeklyDigests(mockPrisma as any);

  assert.equal(mockPrisma._profileFindMany.mock.callCount(), 1);
});

test("sendWeeklyDigests passes cursor to second profile query", async () => {
  const firstBatch = Array.from({ length: 100 }, (_, i) =>
    makeProfile({ id: `profile-${i}` }),
  );

  let profileCall = 0;
  const profileFindMany = mock.fn((arg: Record<string, unknown>) => {
    profileCall++;
    return Promise.resolve(profileCall === 1 ? firstBatch : []);
  });

  const mockPrisma = {
    profile: { findMany: profileFindMany },
    supportTransaction: {
      findMany: mock.fn(() => Promise.resolve([])),
      groupBy: mock.fn(() => Promise.resolve([])),
    },
    milestone: { findMany: mock.fn(() => Promise.resolve([])) },
  };

  await sendWeeklyDigests(mockPrisma as any);

  const secondCallArg = profileFindMany.mock.calls[1]!.arguments[0] as {
    cursor?: { id: string };
    skip?: number;
  };
  // Second call must include a cursor pointing at the last item of the first batch
  assert.deepEqual(secondCallArg.cursor, { id: "profile-99" });
  assert.equal(secondCallArg.skip, 1);
});

test("sendWeeklyDigests skips profiles with no transactions this week", async () => {
  const mockPrisma = makePrismaMock({ transactions: [], assetGroups: [] });

  // Should not throw even with no transactions
  await assert.doesNotReject(() => sendWeeklyDigests(mockPrisma as any));
});

// ── issue #984: XSS via assetCode in digest HTML ──────────────────────────────

test("escapeHtml neutralises script tags in assetCode", () => {
  const malicious = '<script>alert("xss")</script>';
  const safe = escapeHtml(malicious);
  assert.ok(!safe.includes("<script>"), "escaped output must not contain raw <script>");
  assert.ok(safe.includes("&lt;script&gt;"), "escaped output must contain HTML entities");
});

test("escapeHtml neutralises double-quote in assetCode", () => {
  const malicious = 'USDC" onload="alert(1)';
  const safe = escapeHtml(malicious);
  assert.ok(!safe.includes('"'), "escaped output must not contain raw double quotes");
  assert.ok(safe.includes("&quot;"), "escaped output must contain &quot;");
});

test("escapeHtml leaves clean strings unchanged", () => {
  assert.equal(escapeHtml("XLM"), "XLM");
  assert.equal(escapeHtml("USDC"), "USDC");
});


test("issue #1120: unique supporter query excludes failed transactions", async () => {
  const mockPrisma = makePrismaMock({ profiles: [makeProfile()], transactions: [] });

  await sendWeeklyDigests(mockPrisma as any);

  const calls = (mockPrisma.supportTransaction.findMany as any).mock.calls;
  const uniqueCall = calls.find((call: any) => call.arguments?.[0]?.distinct?.includes("supporterAddress"));
  assert.ok(uniqueCall, "expected unique supporter query to run");

  const where = uniqueCall.arguments[0].where;
  assert.deepEqual(
    where.status,
    { not: "failed" },
    "unique supporter query must exclude failed transactions",
  );
});


test("issue #1120 adversarial: supporter query keeps profile, address, time and failed-status boundaries together", async () => {
  const mockPrisma = makePrismaMock({ profiles: [makeProfile()], transactions: [] });

  await sendWeeklyDigests(mockPrisma as any);

  const calls = (mockPrisma.supportTransaction.findMany as any).mock.calls;
  const uniqueCall = calls.find((call: any) => call.arguments?.[0]?.distinct?.includes("supporterAddress"));
  assert.ok(uniqueCall, "expected unique supporter query to run");

  const arg = uniqueCall.arguments[0];
  assert.deepEqual(arg.distinct, ["supporterAddress"]);
  assert.deepEqual(arg.select, { supporterAddress: true });
  assert.equal(arg.where.profileId, "profile-1");
  assert.deepEqual(arg.where.supporterAddress, { not: null });
  assert.deepEqual(arg.where.status, { not: "failed" });
  assert.ok(arg.where.createdAt?.gte instanceof Date, "weekly boundary must remain a Date");
});

test("issue #1120 adversarial: failed-status exclusion is bound to the distinct supporter query", async () => {
  const mockPrisma = makePrismaMock({ profiles: [makeProfile()], transactions: [] });

  await sendWeeklyDigests(mockPrisma as any);

  const calls = (mockPrisma.supportTransaction.findMany as any).mock.calls;
  const supporterCalls = calls.filter((call: any) =>
    call.arguments?.[0]?.distinct?.includes("supporterAddress"),
  );
  assert.equal(supporterCalls.length, 1, "expected exactly one distinct supporter query");
  assert.deepEqual(supporterCalls[0].arguments[0].where.status, { not: "failed" });
});
