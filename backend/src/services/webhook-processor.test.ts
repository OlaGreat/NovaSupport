import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  processPendingWebhookDeliveries,
  startWebhookProcessor,
  reclaimStuckWebhookDeliveries,
} from "./webhook-processor.js";

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

test("successful delivery updates the record to success and increments attemptCount", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  assert.equal(update.mock.calls.length, 1);
  const data = getUpdateData(update);
  assert.equal(data.status, "success");
  assert.equal(data.attemptCount, 1);
  assert.equal(data.lastError, null);
});

test("HTTP 500 keeps status pending and sets nextRetryAt to the backoff schedule", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 500", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "pending");
  assert.equal(data.attemptCount, 1);
  assert.ok(data.nextRetryAt instanceof Date);
  assert.ok((data.nextRetryAt as Date).getTime() > Date.now());
});

test("Redis mode still polls SQL so due webhook retries are delivered", async () => {
  // Drive the interval deterministically instead of racing a real 15ms window
  // that may contain zero or several ticks under CI load.
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let queueStarted = false;
    let workerStarted = false;
    let pollCount = 0;
    const handle = startWebhookProcessor({
      redisAvailable: true,
      intervalMs: 2,
      startQueue: () => {
        queueStarted = true;
        return null;
      },
      startWorker: () => {
        workerStarted = true;
        return null;
      },
      reclaimStuck: async () => 0,
      processPending: async () => {
        pollCount += 1;
      },
    });

    // One interval period fires exactly one sweep; `stop()` awaits it.
    mock.timers.tick(2);
    await handle.stop();

    assert.equal(queueStarted, true);
    assert.equal(workerStarted, true);
    assert.equal(pollCount, 1, "the SQL retry sweep should run while Redis is active");
  } finally {
    mock.timers.reset();
  }
});

test("HTTP 4xx permanent failure sets status failed with no further retry scheduled", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 404", willRetry: false }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "failed");
  assert.equal(data.nextRetryAt, null);
});

test("reaching max attempts sets status to failed", async () => {
  // attemptCount is already at MAX_DELIVERY_ATTEMPTS - 1 (2); the query itself
  // filters attemptCount < MAX_DELIVERY_ATTEMPTS (3), so this is the last try.
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 2 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "HTTP 500", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  // nextAttempt = 3, shouldRetry(3) is expected to be false at the max attempt.
  assert.equal(data.status, "failed");
  assert.equal(data.attemptCount, 3);
});

test("a concurrency of 0 is clamped instead of looping forever (#1500)", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ id: "d1" }), makeDelivery({ id: "d2" })],
  });
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any, 0);

  assert.equal(deliver.mock.calls.length, 2);
  assert.equal(update.mock.calls.length, 2);
});

test("the final status write is guarded on this worker's claim (#1501)", async () => {
  const { prismaClient, updateMany } = buildPrismaMock();
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const claim = updateMany.mock.calls[0]!.arguments[0] as any;
  const final = updateMany.mock.calls[1]!.arguments[0] as any;
  assert.equal(final.where.status, "processing");
  assert.equal(final.where.updatedAt, claim.data.updatedAt);
});

test("a network timeout is treated as a transient failure and scheduled for retry", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery({ attemptCount: 0 })],
  });
  const deliver = mock.fn(() =>
    Promise.resolve({ status: "failed", error: "The operation was aborted due to timeout", willRetry: true }),
  );

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  const data = getUpdateData(update);
  assert.equal(data.status, "pending");
  assert.ok(data.nextRetryAt instanceof Date);
});

test("a row already claimed by a concurrent run is skipped (no delivery attempted)", async () => {
  const { prismaClient, update } = buildPrismaMock({
    deliveries: [makeDelivery()],
    claimCount: 0,
  });
  const deliver = mock.fn(() => Promise.resolve({ status: "success", statusCode: 200 }));

  await processPendingWebhookDeliveries(prismaClient as any, deliver as any);

  assert.equal(deliver.mock.calls.length, 0);
  assert.equal(update.mock.calls.length, 0);
});

// ── issue #1351: deliveries stuck in "processing" are never reclaimed ──

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
