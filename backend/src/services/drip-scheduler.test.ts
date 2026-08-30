import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { processDueRecurringSupports } from "./drip-scheduler.js";

function makeSupport(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: "drip-1",
    amount: 100n,
    assetCode: "XLM",
    frequency: "weekly",
    status: "active",
    nextRunAt: new Date(now.getTime() - 60000),
    profileId: "profile-1",
    supporterId: "supporter-1",
    profile: {
      walletAddress: "GAAAA",
    },
    supporter: {
      email: "supporter@test.com",
    },
    ...overrides,
  };
}

interface ExecutionCreateArg {
  data: Record<string, unknown>;
}

interface FindManyArg {
  where: { status: string; nextRunAt: { lte: Date } };
  take: number;
}

function getFirstArg<T>(mockFn: ReturnType<typeof mock.fn>): T {
  return (mockFn.mock.calls[0]!.arguments[0] as unknown) as T;
}

function getRawSql(mockFn: ReturnType<typeof mock.fn>): string {
  const strings = mockFn.mock.calls[0]?.arguments[0] as string[] | undefined;
  return strings ? strings.join("?") : "";
}

function getRawValue(mockFn: ReturnType<typeof mock.fn>, index: number): unknown {
  const args = (mockFn.mock.calls[0] as { arguments: unknown[] }).arguments;
  return args[index];
}

function buildPrismaMock(overrides: {
  recurringSupports?: unknown[];
  claimCount?: number;
} = {}) {
  const recurringSupportFindMany = mock.fn(() =>
    Promise.resolve(overrides.recurringSupports ?? [makeSupport()]),
  );
  const recurringSupportUpdate = mock.fn(() => Promise.resolve({}));
  const recurringSupportExecutionCreate = mock.fn(() => Promise.resolve({}));
  const $executeRaw = mock.fn(() => Promise.resolve(overrides.claimCount ?? 1));

  return {
    recurringSupport: { findMany: recurringSupportFindMany, update: recurringSupportUpdate },
    recurringSupportExecution: { create: recurringSupportExecutionCreate },
    $executeRaw,
  };
}

test("processDueRecurringSupports processes active due supports", async () => {
  const mockPrisma = buildPrismaMock();

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(mockPrisma.recurringSupport.findMany.mock.callCount(), 1);
  assert.equal(mockPrisma.$executeRaw.mock.callCount(), 1);
  assert.equal(mockPrisma.recurringSupportExecution.create.mock.callCount(), 1);

  const createCall = getFirstArg<ExecutionCreateArg>(mockPrisma.recurringSupportExecution.create);
  assert.equal(createCall.data.recurringSupportId, "drip-1");
  assert.equal(createCall.data.status, "pending");
});

test("processDueRecurringSupports advances nextRunAt for weekly frequency", async () => {
  const nextRunAt = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
  const mockPrisma = buildPrismaMock({
    recurringSupports: [makeSupport({ frequency: "weekly", nextRunAt })],
  });

  await processDueRecurringSupports(mockPrisma as any, nextRunAt);

  const sql = getRawSql(mockPrisma.$executeRaw);
  assert.ok(sql.includes('"nextRunAt"'), "claim should update the nextRunAt column");
  const expectedNext = new Date(nextRunAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  const claimedNext = getRawValue(mockPrisma.$executeRaw, 1) as Date;
  assert.equal(claimedNext.getTime(), expectedNext.getTime());
});

test("processDueRecurringSupports advances nextRunAt for monthly frequency", async () => {
  const nextRunAt = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
  const mockPrisma = buildPrismaMock({
    recurringSupports: [makeSupport({ frequency: "monthly", nextRunAt })],
  });

  await processDueRecurringSupports(mockPrisma as any, nextRunAt);

  const claimedNext = getRawValue(mockPrisma.$executeRaw, 1) as Date;
  assert.equal(claimedNext.getUTCMonth(), 1, "should land in February, not March");
  assert.equal(claimedNext.getUTCDate(), 29);
});

// ── Month-boundary regression test (issue #645) ──────────────────────────────

test("processDueRecurringSupports does not overflow into the wrong month at month-end boundaries", async () => {
  const jan31 = new Date(Date.UTC(2024, 0, 31, 12, 0, 0));
  const mockPrisma = buildPrismaMock({
    recurringSupports: [makeSupport({ frequency: "monthly", nextRunAt: jan31 })],
  });

  await processDueRecurringSupports(mockPrisma as any, jan31);

  const claimedNext = getRawValue(mockPrisma.$executeRaw, 1) as Date;
  // Jan 31 + 1 month should clamp to Feb 29 (2024 is a leap year), not roll
  // over into March as `setDate(getDate() + 30)` used to.
  assert.equal(claimedNext.getUTCMonth(), 1, "should land in February, not March");
  assert.equal(claimedNext.getUTCDate(), 29);
});

// ── Atomic-claim status guard tests (issue #1051) ────────────────────────────

test("processDueRecurringSupports scopes the atomic claim to active subscriptions", async () => {
  const mockPrisma = buildPrismaMock();

  await processDueRecurringSupports(mockPrisma as any);

  const sql = getRawSql(mockPrisma.$executeRaw);
  assert.ok(
    sql.includes(`"status" = 'active'`),
    `atomic claim should be scoped to active subscriptions, got: ${sql}`,
  );
});

test("processDueRecurringSupports does not create an execution when the claim is lost to a cancel or pause", async () => {
  const mockPrisma = buildPrismaMock({ claimCount: 0 });

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(mockPrisma.$executeRaw.mock.callCount(), 1);
  assert.equal(
    mockPrisma.recurringSupportExecution.create.mock.callCount(),
    0,
    "a lost claim must not create a pending execution",
  );
});

test("processDueRecurringSupports no-ops when no due supports exist", async () => {
  const mockPrisma = buildPrismaMock({ recurringSupports: [] });

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(mockPrisma.recurringSupport.findMany.mock.callCount(), 1);
  assert.equal(mockPrisma.$executeRaw.mock.callCount(), 0);
  assert.equal(mockPrisma.recurringSupportExecution.create.mock.callCount(), 0);
});

test("processDueRecurringSupports cancels drips whose supporter account was deleted", async () => {
  const mockPrisma = buildPrismaMock({
    recurringSupports: [makeSupport({ supporter: null })],
  });

  await processDueRecurringSupports(mockPrisma as any);

  const updateCall = getFirstArg<{ data: { status: string; cancelledAt: Date } }>(
    mockPrisma.recurringSupport.update,
  );
  assert.equal(updateCall.data.status, "cancelled");
  assert.ok(updateCall.data.cancelledAt instanceof Date);
  assert.equal(mockPrisma.$executeRaw.mock.callCount(), 0);
  assert.equal(mockPrisma.recurringSupportExecution.create.mock.callCount(), 0);
});

test("processDueRecurringSupports continues processing after individual failure", async () => {
  let callIndex = 0;
  const $executeRaw = mock.fn(() => {
    callIndex++;
    if (callIndex === 1) {
      return Promise.reject(new Error("First drip failed"));
    }
    return Promise.resolve(1);
  });

  const mockPrisma = {
    recurringSupport: {
      findMany: mock.fn(() =>
        Promise.resolve([makeSupport({ id: "drip-1" }), makeSupport({ id: "drip-2" })]),
      ),
      update: mock.fn(() => Promise.resolve({})),
    },
    recurringSupportExecution: { create: mock.fn(() => Promise.resolve({})) },
    $executeRaw,
  };

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal($executeRaw.mock.callCount(), 2);
});

test("processDueRecurringSupports filters for active status with due nextRunAt", async () => {
  const mockPrisma = buildPrismaMock();

  await processDueRecurringSupports(mockPrisma as any);

  const findManyCall = getFirstArg<FindManyArg>(mockPrisma.recurringSupport.findMany);
  assert.equal(findManyCall.where.status, "active");
  assert.ok(findManyCall.where.nextRunAt.lte instanceof Date);
});

// ── Batch pagination tests (issue #654) ──────────────────────────────────────

test("processDueRecurringSupports uses take: 100 to limit each query", async () => {
  const mockPrisma = buildPrismaMock({ recurringSupports: [] });

  await processDueRecurringSupports(mockPrisma as any);

  const findManyArg = getFirstArg<{ take: number }>(mockPrisma.recurringSupport.findMany);
  assert.equal(findManyArg.take, 100);
});

test("processDueRecurringSupports stops after one query when batch is smaller than 100", async () => {
  // 2 records returned — well under the batch size, so no second query needed
  const mockPrisma = buildPrismaMock({
    recurringSupports: [makeSupport({ id: "drip-1" }), makeSupport({ id: "drip-2" })],
  });

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(mockPrisma.recurringSupport.findMany.mock.callCount(), 1);
});

test("processDueRecurringSupports queries again when a full batch of 100 is returned", async () => {
  const firstBatch = Array.from({ length: 100 }, (_, i) =>
    makeSupport({ id: `drip-${i}` }),
  );

  let call = 0;
  const recurringSupportFindMany = mock.fn(() => {
    call++;
    return Promise.resolve(call === 1 ? firstBatch : []);
  });
  const recurringSupportUpdate = mock.fn(() => Promise.resolve({}));
  const recurringSupportExecutionCreate = mock.fn(() => Promise.resolve({}));
  const $executeRaw = mock.fn(() => Promise.resolve(1));
  const mockPrisma = {
    recurringSupport: { findMany: recurringSupportFindMany, update: recurringSupportUpdate },
    recurringSupportExecution: { create: recurringSupportExecutionCreate },
    $executeRaw,
  };

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(recurringSupportFindMany.mock.callCount(), 2);
  assert.equal($executeRaw.mock.callCount(), 100);
});
