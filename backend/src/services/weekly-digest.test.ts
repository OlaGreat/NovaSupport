import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { sendWeeklyDigests, maybeRunWeeklyDigest, DIGEST_RESEND_GUARD_MS } from "./weekly-digest.js";
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
  const milestoneFindMany = mock.fn((_arg?: unknown) =>
    Promise.resolve(overrides.milestones ?? []),
  );
  const txGroupBy = mock.fn(() =>
    Promise.resolve(overrides.assetGroups ?? [makeAssetGroup("XLM", "5")]),
  );

  return {
    profile: { findMany: profileFindMany },
    notificationPreferences: { update: mock.fn(() => Promise.resolve({})) },
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
  const capturedEmails: Array<{ to: string; subject: string; html?: string; text?: string }> = [];

  const mockSendEmail = mock.fn(async (opts: { to: string; subject: string; html?: string; text?: string }) => {
    capturedEmails.push(opts);
  });

  const xlmGroup = makeAssetGroup("XLM", "5");
  const usdcGroup = makeAssetGroup("USDC", "5");

  const mockPrisma = makePrismaMock({
    assetGroups: [xlmGroup, usdcGroup],
  });

  await sendWeeklyDigests(mockPrisma as any, mockSendEmail as any);

  // The function was called — an email was sent
  assert.ok(capturedEmails.length > 0, "sendEmail should have been called");

  const html = capturedEmails[0].html ?? "";

  // The old (wrong) behaviour would produce "10.0000000" — sum of 5+5.
  // The new behaviour shows per-asset breakdown only.
  const wrongTotal = (5 + 5).toFixed(7); // "10.0000000"
  assert.ok(!html.includes(wrongTotal), "cross-asset total must not appear in email HTML");

  // Per-asset amounts should still be present
  assert.ok(html.includes("5.0000000 XLM"), "XLM amount should appear in email");
  assert.ok(html.includes("5.0000000 USDC"), "USDC amount should appear in email");
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

test("sendWeeklyDigests filters milestone reach events by reachedAt instead of updatedAt", async () => {
  const mockPrisma = makePrismaMock({
    profiles: [makeProfile()],
    transactions: [{ amount: 5n, assetCode: "XLM", createdAt: new Date() }],
    milestones: [],
    assetGroups: [makeAssetGroup("XLM", "5")],
  });

  await sendWeeklyDigests(mockPrisma as any);

  const milestoneCall = mockPrisma.milestone.findMany.mock.calls[0]?.arguments[0] as {
    where: { status: string; reachedAt?: { gte: Date }; updatedAt?: unknown };
  } | undefined;
  assert.ok(milestoneCall);
  assert.deepEqual(milestoneCall.where.status, "reached");
  assert.ok(milestoneCall.where.reachedAt);
  assert.ok(milestoneCall.where.reachedAt.gte instanceof Date);
  assert.equal("updatedAt" in milestoneCall.where, false);
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

// ── issue #1349: claim persisted before the run completes ─────────────────────

type SchedulerPrismaMock = {
  prismaClient: {
    $queryRaw: ReturnType<typeof mock.fn>;
    schedulerJob: { updateMany: ReturnType<typeof mock.fn> };
  };
  queryRaw: ReturnType<typeof mock.fn>;
  updateMany: ReturnType<typeof mock.fn>;
};

function buildSchedulerPrismaMock(options: { claimed?: boolean } = {}): SchedulerPrismaMock {
  const queryRaw = mock.fn(() =>
    Promise.resolve(options.claimed === false ? [] : [{ name: "weekly-digest" }]),
  );
  const updateMany = mock.fn(() => Promise.resolve({ count: 1 }));
  return {
    prismaClient: { $queryRaw: queryRaw, schedulerJob: { updateMany } },
    queryRaw,
    updateMany,
  };
}

test("a successful run keeps its claim", async () => {
  const { prismaClient, updateMany } = buildSchedulerPrismaMock();
  const sendDigests = mock.fn(() => Promise.resolve());

  await maybeRunWeeklyDigest(prismaClient as never, sendDigests as never);

  assert.equal(sendDigests.mock.calls.length, 1);
  assert.equal(updateMany.mock.calls.length, 0, "a completed run must not release its claim");
});

test("a failed run releases the claim so the next tick can retry", async () => {
  const { prismaClient, updateMany } = buildSchedulerPrismaMock();
  const sendDigests = mock.fn(() => Promise.reject(new Error("db pool exhausted")));

  await assert.rejects(() => maybeRunWeeklyDigest(prismaClient as never, sendDigests as never));

  assert.equal(updateMany.mock.calls.length, 1, "the claim must be given back after a failure");
  const [args] = updateMany.mock.calls[0]!.arguments as [{ where: { name: string }; data: { lastRunAt: Date } }];
  assert.equal(args.where.name, "weekly-digest");
  assert.ok(
    args.data.lastRunAt.getTime() < Date.now(),
    "released lastRunAt must be due immediately",
  );
});

test("no claim means no send and no release", async () => {
  const { prismaClient, updateMany } = buildSchedulerPrismaMock({ claimed: false });
  const sendDigests = mock.fn(() => Promise.resolve());

  await maybeRunWeeklyDigest(prismaClient as never, sendDigests as never);

  assert.equal(sendDigests.mock.calls.length, 0);
  assert.equal(updateMany.mock.calls.length, 0);
});

// ── issue #1499: a retried run must not re-send to profiles already emailed ──

type DigestProfile = ReturnType<typeof makeProfile> & {
  notificationPreferences: { weeklyDigest: boolean; lastWeeklyDigestSentAt?: Date | null };
};

/** Stateful mock: marking a profile sent persists across runs, like the DB. */
function makeStatefulDigestMock(profiles: DigestProfile[], failSecondPageOnce: boolean) {
  let failNext = failSecondPageOnce;
  const base = makePrismaMock();
  const findMany = mock.fn((args: { take: number; cursor?: { id: string } }) => {
    const start = args.cursor ? profiles.findIndex((p) => p.id === args.cursor!.id) + 1 : 0;
    if (start > 0 && failNext) {
      failNext = false;
      return Promise.reject(new Error("connection reset during batch query"));
    }
    return Promise.resolve(profiles.slice(start, start + args.take));
  });
  const update = mock.fn(
    (args: { where: { profileId: string }; data: { lastWeeklyDigestSentAt: Date } }) => {
      const profile = profiles.find((p) => p.id === args.where.profileId)!;
      profile.notificationPreferences.lastWeeklyDigestSentAt = args.data.lastWeeklyDigestSentAt;
      return Promise.resolve({});
    },
  );
  return { ...base, profile: { findMany }, notificationPreferences: { update } };
}

test("a retry after a partially failed run does not re-send to profiles already emailed (#1499)", async () => {
  const profiles: DigestProfile[] = Array.from({ length: 101 }, (_, i) =>
    makeProfile({
      id: `profile-${String(i).padStart(3, "0")}`,
      email: `creator-${i}@test.com`,
      notificationPreferences: { weeklyDigest: true, lastWeeklyDigestSentAt: null },
    }) as DigestProfile,
  );
  const mockPrisma = makeStatefulDigestMock(profiles, true);
  const sent: string[] = [];
  const sendEmail = mock.fn(async (opts: { to: string }) => {
    sent.push(opts.to);
  });

  // First run emails the first page of 100, then the second page query throws.
  await assert.rejects(() => sendWeeklyDigests(mockPrisma as never, sendEmail as never));
  assert.equal(sent.length, 100);

  // The retry must only reach the profile the failed run never got to.
  await sendWeeklyDigests(mockPrisma as never, sendEmail as never);
  assert.equal(sent.length, 101);
  assert.equal(new Set(sent).size, 101, "no profile may receive the digest twice");
  assert.deepEqual(sent.slice(100), ["creator-100@test.com"]);
});

test("a profile emailed more than the resend guard ago gets next week's digest", async () => {
  const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  assert.ok(Date.now() - lastWeek.getTime() > DIGEST_RESEND_GUARD_MS);
  const profiles = [
    makeProfile({ notificationPreferences: { weeklyDigest: true, lastWeeklyDigestSentAt: lastWeek } }) as DigestProfile,
  ];
  const mockPrisma = makeStatefulDigestMock(profiles, false);
  const sendEmail = mock.fn(async () => {});

  await sendWeeklyDigests(mockPrisma as never, sendEmail as never);

  assert.equal(sendEmail.mock.calls.length, 1);
  assert.ok(profiles[0]!.notificationPreferences.lastWeeklyDigestSentAt! > lastWeek);
});

test("a failure to record the send still counts the email and keeps going", async () => {
  const profiles = [
    makeProfile({ id: "profile-a", email: "a@test.com" }),
    makeProfile({ id: "profile-b", email: "b@test.com" }),
  ];
  const mockPrisma = makePrismaMock({ profiles });
  mockPrisma.notificationPreferences.update = mock.fn(() => Promise.reject(new Error("write failed")));
  const sendEmail = mock.fn(async () => {});

  await sendWeeklyDigests(mockPrisma as never, sendEmail as never);

  assert.equal(sendEmail.mock.calls.length, 2);
});
