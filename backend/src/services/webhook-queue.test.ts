import { test, mock } from "node:test";
import assert from "node:assert/strict";
import type { Queue, Worker } from "bullmq";
import {
  createWebhookQueue,
  createWebhookWorker,
  stopWebhookQueue,
} from "./webhook-queue.js";

// ── issue #1352: re-entrancy guard must not leak the previous instance ────────

test("createWebhookQueue returns the existing instance instead of leaking a duplicate", async () => {
  let created = 0;
  const fakeQueue = { close: async () => {} } as unknown as Queue;
  const createQueue = mock.fn(() => {
    created += 1;
    return fakeQueue;
  });

  try {
    const first = createWebhookQueue({
      isRedisAvailable: () => true,
      createQueue: createQueue as never,
    });
    const second = createWebhookQueue({
      isRedisAvailable: () => true,
      createQueue: createQueue as never,
    });

    assert.equal(created, 1, "the queue factory must only run once");
    assert.equal(first, fakeQueue);
    assert.equal(second, fakeQueue, "the second call must return the live instance");
  } finally {
    await stopWebhookQueue();
  }
});

test("createWebhookWorker returns the existing instance instead of leaking a duplicate", async () => {
  let created = 0;
  const fakeWorker = { on: () => {}, close: async () => {} } as unknown as Worker;
  const createWorker = mock.fn(() => {
    created += 1;
    return fakeWorker;
  });

  try {
    const first = createWebhookWorker({
      isRedisAvailable: () => true,
      createWorker: createWorker as never,
    });
    const second = createWebhookWorker({
      isRedisAvailable: () => true,
      createWorker: createWorker as never,
    });

    assert.equal(created, 1, "the worker factory must only run once");
    assert.equal(first, fakeWorker);
    assert.equal(second, fakeWorker, "the second call must return the live instance");
  } finally {
    await stopWebhookQueue();
  }
});

test("creation is a no-op when Redis is unavailable", () => {
  assert.equal(
    createWebhookQueue({ isRedisAvailable: () => false }),
    null,
  );
  assert.equal(
    createWebhookWorker({ isRedisAvailable: () => false }),
    null,
  );
});
