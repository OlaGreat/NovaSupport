import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { processDueRecurringSupports } from "./drip-scheduler.js";
import { prisma } from "../db.js";
import { seedUser, seedProfile, seedRecurringSupport, cleanupTestData } from "../test-harness.js";

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

  // Executions that a real database would still hold once the transaction has
  // settled. A create staged inside `$transaction` is only durable if the
  // callback commits, so `$transaction` truncates this back to its
  // pre-transaction length when the callback throws — the mock equivalent of
  // ROLLBACK. A create issued outside the transaction stays, which is what
  // makes this mock able to catch a regression that moved the insert out of
  // the transaction.
  const committedExecutions: ExecutionCreateArg[] = [];

  const recurringSupportExecutionCreate = mock.fn((arg: ExecutionCreateArg) => {
    committedExecutions.push(arg);
    return Promise.resolve({});
  });

  const $executeRaw = mock.fn(() => Promise.resolve(overrides.claimCount ?? 1));
  const $transaction = mock.fn(
    async (callback: (transaction: unknown) => Promise<unknown>) => {
      const committedBefore = committedExecutions.length;
      try {
        return await callback({
          recurringSupportExecution: { create: recurringSupportExecutionCreate },
          $executeRaw,
        });
      } catch (error) {
        committedExecutions.length = committedBefore;
        throw error;
      }
    },
  );

  return {
    recurringSupport: { findMany: recurringSupportFindMany, update: recurringSupportUpdate },
    recurringSupportExecution: { create: recurringSupportExecutionCreate },
    committedExecutions,
    $executeRaw,
    $transaction,
  };
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

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "delivery-1",
    webhookId: "webhook-1",
    payload: { event: "support.created" },
    status: "pending",
    attemptCount: 0,
    nextRetryAt: new Date(),
    webhook: { url: "https://example.com/hook", secret: "s3cret" },
    ...overrides,
  };
}

function buildPrismaMock(overrides: {
  deliveries?: unknown[];
  claimCount?: number;
} = {}) {
  const findMany = mock.fn(() => Promise.resolve(overrides.deliveries ?? [makeDelivery()]));
  // Final status writes are guarded updateMany calls; record them in `update`.
  const update = mock.fn((_args: unknown) => Promise.resolve({ count: 1 }));
  const updateMany = mock.fn((args: { where: { status?: string } }) =>
    args.where.status === "pending"
      ? Promise.resolve({ count: overrides.claimCount ?? 1 })
      : update(args),
  );

  return {
    prismaClient: {
      webhookDelivery: { findMany, update, updateMany },
    },
    findMany,
    updateMany,
    update,
  };
}

function getUpdateData(update: ReturnType<typeof mock.fn>, callIndex = 0): Record<string, unknown> {
  return (update.mock.calls[callIndex]!.arguments[0] as { data: Record<string, unknown> }).data;
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

// ── Month-boundary regression test (issue #645) ──

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

// ── Atomic-claim status guard tests (issue #1051) ──

test("processDueRecurringSupports scopes the atomic claim to active subscriptions", async () => {
  const mockPrisma = buildPrismaMock();

  await processDueRecurringSupports(mockPrisma as any);

  const sql = getRawSql(mockPrisma.$executeRaw);
  assert.ok(
    sql.includes(`"status" = 'active'`),
    `atomic claim should be scoped to active subscriptions, got: ${sql}`,
  );
});

test("processDueRecurringSupports does not persist an execution when the claim is lost to a cancel or pause", async () => {
  const mockPrisma = buildPrismaMock({ claimCount: 0 });

  await processDueRecurringSupports(
    mockPrisma as unknown as Parameters<typeof processDueRecurringSupports>[0],
  );

  // The insert is attempted before the atomic claim, inside the transaction...
  assert.equal(mockPrisma.$executeRaw.mock.callCount(), 1);
  assert.equal(mockPrisma.recurringSupportExecution.create.mock.callCount(), 1);
  // ...but the claim matches no active row, the transaction rolls back, and no
  // execution row survives. Asserting on the mock's raw call count would pass
  // even if rollback were broken, because a mock has no rollback semantics.
  assert.equal(
    mockPrisma.committedExecutions.length,
    0,
    "a rolled-back insert must not leave an execution behind",
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

test("processDueRecurringSupports keeps processing the batch when a supporter-deleted cancellation write fails (#1498)", async () => {
  const mockPrisma = buildPrismaMock({
    recurringSupports: [
      makeSupport({ id: "drip-deleted", supporter: null }),
      makeSupport({ id: "drip-ok" }),
    ],
  });
  mockPrisma.recurringSupport.update = mock.fn(() =>
    Promise.reject(new Error("transient database error")),
  );

  await processDueRecurringSupports(
    mockPrisma as unknown as Parameters<typeof processDueRecurringSupports>[0],
  );

  assert.equal(mockPrisma.recurringSupport.update.mock.callCount(), 1);
  assert.equal(mockPrisma.$transaction.mock.callCount(), 1);
  assert.equal(mockPrisma.recurringSupportExecution.create.mock.callCount(), 1);
  const created = getFirstArg<ExecutionCreateArg>(mockPrisma.recurringSupportExecution.create);
  assert.equal(created.data.recurringSupportId, "drip-ok");
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

  const executionCreate = mock.fn(() => Promise.resolve({}));
  const mockPrisma = {
    recurringSupport: {
      findMany: mock.fn(() =>
        Promise.resolve([makeSupport({ id: "drip-1" }), makeSupport({ id: "drip-2" })]),
      ),
      update: mock.fn(() => Promise.resolve({}),
    ),
    recurringSupportExecution: { create: executionCreate },
    $executeRaw,
    // The claim runs inside $transaction (see buildPrismaMock), so a mock that
    // omits it would throw before ever reaching $executeRaw.
    $transaction: mock.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
      callback({
        recurringSupportExecution: { create: executionCreate },
        $executeRaw,
      }),
    ),
  };

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal($executeRaw.mock.callCount(), 2);
});

// ── Batch pagination tests (issue #654) ──

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
  const $transaction = mock.fn(async (callback: (transaction: unknown) => Promise<unknown>) =>
    callback({
      recurringSupportExecution: { create: recurringSupportExecutionCreate },
      $executeRaw,
    }),
  );
  const mockPrisma = {
    recurringSupport: { findMany: recurringSupportFindMany, update: recurringSupportUpdate },
    recurringSupportExecution: { create: recurringSupportExecutionCreate },
    $executeRaw,
    $transaction,
  };

  await processDueRecurringSupports(mockPrisma as any);

  assert.equal(recurringSupportFindMany.mock.callCount(), 2);
  assert.equal($executeRaw.mock.callCount(), 100);
});

// ── Integration tests (real Postgres database) ──

test("processDueRecurringSupports integration: creates execution for due recurring support", async () => {
  const userId = await seedUser();
  const profileId = await seedProfile(userId);
  const supporterId = await seedUser();
  const now = new Date();
  const dueDate = new Date(now.getTime() - 60000);

  const dripId = await seedRecurringSupport(profileId, supporterId, {
    frequency: "weekly",
    nextRunAt: dueDate,
    status: "active",
  });

  await processDueRecurringSupports(prisma);

  const execution = await prisma.recurringSupportExecution.findFirst({
    where: { recurringSupportId: dripId },
  });

  assert.ok(execution, "Should create an execution for due recurring support");
  assert.equal(execution.status, "pending");

  await cleanupTestData([profileId], [userId, supporterId]);
});

test("processDueRecurringSupports integration: advances nextRunAt correctly", async () => {
  const userId = await seedUser();
  const profileId = await seedProfile(userId);
  const nextRunAt = new Date(Date.UTC(2024, 0, 15, 12, 0, 0));

  await seedRecurringSupport(profileId, supporterId, {
    frequency: "weekly",
    nextRunAt,
    status: "active",
  });

  await processDueRecurringSupports(prisma, nextRunAt);

  const updated = await prisma.recurringSupport.findFirst({
    where: { profileId },
  });

  assert.ok(updated, "Recurring support should exist");
  const expectedNext = new Date(nextRunAt.getTime() + 7 * 24 * 60 * 60 * 1000);
  assert.equal(updated.nextRunAt.getTime(), expectedNext.getTime(), "nextRunAt should advance by 1 week");

  await cleanupTestData([profileId], [userId, supporterId]);
});

// ── Month-boundary regression test (issue #645) ──

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

// ── Atomic-claim status guard tests (issue #1051) ──

test("processDueRecurringSupports scopes the atomic claim to active subscriptions", async () => {
  const mockPrisma = buildPrismaMock();

  await processDueRecurringSupports(mockPrisma as any);

  const sql = getRawSql(mockPrisma.$executeRaw);
  assert.ok(
    sql.includes(`"status" = 'active'`),
    `atomic claim should be scoped to active subscriptions, got: ${sql}`,
  );
});

// ── Issue #1351: deliveries stuck in "processing" are never reclaimed ──

function buildReclaimPrismaMock(stuck: Array<{ id: string; attemptCount: number }>, counts: number[] = []) {
  const findMany = mock.fn(() => Promise.resolve(stuck));
  const updateMany = mock.fn(() => Promise.resolve({ count: counts.shift() ?? 1 }));
  return {
    prismaClient: { webhookDelivery: { findMany, updateMany } },
    findMany,
    updateMany,
  };
}

test("a delivery stuck in processing is returned to pending so it can be retried", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([
    { id: "stuck-1", attemptCount: 1 },
  ]);
  const now = new Date("2026-07-27T00:00:00Z");

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, now, 60_000);

  assert.equal(count, 1);
  const [args] = updateMany.mock.calls[0]!.arguments as [
    { where: { id: string; status: string; updatedAt: { lte: Date } }; data: { status: string; nextRetryAt: Date } },
  ];
  assert.equal(args.where.id, "stuck-1");
  assert.equal(args.where.status, "processing");
  assert.deepEqual(args.where.updatedAt.lte, new Date(now.getTime() - 60_000));
  assert.equal(args.data.status, "pending");
  assert.deepEqual(args.data.nextRetryAt, now);
});

test("only deliveries stuck past the threshold are selected", async () => {
  const { prismaClient, findMany } = buildReclaimPrismaMock([]);
  const now = new Date("2026-07-27T00:00:00Z");

  await reclaimStuckWebhookDeliveries(prismaClient as never, now, 5 * 60 * 1000);

  const [args] = findMany.mock.calls[0]!.arguments as [{ where: { status: string; updatedAt: { lte: Date } } }];
  assert.equal(args.where.status, "processing");
  assert.deepEqual(args.where.updatedAt.lte, new Date(now.getTime() - 5 * 60 * 1000));
});

test("a stuck delivery that has burned every attempt is failed, not retried", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([
    { id: "stuck-exhausted", attemptCount: 3 },
  ]);

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, new Date(), 60_000);

  assert.equal(count, 1);
  const [args] = updateMany.mock.calls[0]!.arguments as [{ data: { status: string } }];
  assert.equal(args.data.status, "failed");
});

test("nothing stuck means no writes at all", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([]);

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, new Date(), 60_000);

  assert.equal(count, 0);
  assert.equal(updateMany.mock.calls.length, 0);
});

test("the processor sweep reclaims stuck deliveries before polling pending ones", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const order: string[] = [];
    const handle = startWebhookProcessor({
      redisAvailable: false,
      intervalMs: 2,
      reclaimStuck: async () => {
        order.push("reclaim");
        return 1;
      },
      processPending: async () => {
        order.push("poll");
      },
    });

    mock.timers.tick(2);
    await handle.stop();

    // Exactly one tick, so the ordering assertion cannot be diluted by a
    // second sweep slipping into a real-time wait.
    assert.deepEqual(order, ["reclaim", "poll"]);
  } finally {
    mock.timers.reset();
  }
});

test("a failing reclaim is caught and does not crash the processor loop", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let polled = 0;
    const handle = startWebhookProcessor({
      redisAvailable: false,
      intervalMs: 2,
      reclaimStuck: async () => {
        throw new Error("db down");
      },
      processPending: async () => {
        polled += 1;
      },
    });

    mock.timers.tick(2);
    await handle.stop();

    assert.equal(polled, 0, "this tick is skipped after a failed reclaim");
  } finally {
    mock.timers.reset();
  }
});

// ── issue #1351: deliveries stuck in "processing" are never reclaimed ──

test("a delivery stuck in processing is returned to pending so it can be retried", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([
    { id: "stuck-1", attemptCount: 1 },
  ]);
  const now = new Date("2026-07-27T00:00:00Z");

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, now, 60_000);

  assert.equal(count, 1);
  const [args] = updateMany.mock.calls[0]!.arguments as [
    { where: { id: string; status: string; updatedAt: { lte: Date } }; data: { status: string; nextRetryAt: Date } },
  ];
  assert.equal(args.where.id, "stuck-1");
  assert.equal(args.where.status, "processing");
  assert.deepEqual(args.where.updatedAt.lte, new Date(now.getTime() - 60_000));
  assert.equal(args.data.status, "pending");
  assert.deepEqual(args.data.nextRetryAt, now);
});

test("only deliveries stuck past the threshold are selected", async () => {
  const { prismaClient, findMany } = buildReclaimPrismaMock([]);
  const now = new Date("2026-07-27T00:00:00Z");

  await reclaimStuckWebhookDeliveries(prismaClient as never, now, 5 * 60 * 1000);

  const [args] = findMany.mock.calls[0]!.arguments as [{ where: { status: string; updatedAt: { lte: Date } } }];
  assert.equal(args.where.status, "processing");
  assert.deepEqual(args.where.updatedAt.lte, new Date(now.getTime() - 5 * 60 * 1000));
});

test("a stuck delivery that has burned every attempt is failed, not retried", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([
    { id: "stuck-exhausted", attemptCount: 3 },
  ]);

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, new Date(), 60_000);

  assert.equal(count, 1);
  const [args] = updateMany.mock.calls[0]!.arguments as [{ data: { status: string } }];
  assert.equal(args.data.status, "failed");
});

test("nothing stuck means no writes at all", async () => {
  const { prismaClient, updateMany } = buildReclaimPrismaMock([]);

  const count = await reclaimStuckWebhookDeliveries(prismaClient as never, new Date(), 60_000);

  assert.equal(count, 0);
  assert.equal(updateMany.mock.calls.length, 0);
});

test("the processor sweep reclaims stuck deliveries before polling pending ones", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    const order: string[] = [];
    const handle = startWebhookProcessor({
      redisAvailable: false,
      intervalMs: 2,
      reclaimStuck: async () => {
        order.push("reclaim");
        return 1;
      },
      processPending: async () => {
        order.push("poll");
      },
    });

    mock.timers.tick(2);
    await handle.stop();

    // Exactly one tick, so the ordering assertion cannot be diluted by a
    // second sweep slipping into a real-time wait.
    assert.deepEqual(order, ["reclaim", "poll"]);
  } finally {
    mock.timers.reset();
  }
});

test("a failing reclaim is caught and does not crash the processor loop", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let polled = 0;
    const handle = startWebhookProcessor({
      redisAvailable: false,
      intervalMs: 2,
      reclaimStuck: async () => {
        throw new Error("db down");
      },
      processPending: async () => {
        polled += 1;
      },
    });

    mock.timers.tick(2);
    await handle.stop();

    assert.equal(polled, 0, "this tick is skipped after a failed reclaim");
  } finally {
    mock.timers.reset();
  }
});