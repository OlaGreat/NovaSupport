import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { deliverWebhook, shouldRetry, getNextRetryDelay } from "./webhook.js";
import { Metrics } from "../metrics.js";
import { getIsRedisAvailable } from "./redis.js";
import {
  createWebhookQueue,
  createWebhookWorker,
  enqueueWebhookDelivery,
  stopWebhookQueue,
  getWebhookQueue,
} from "./webhook-queue.js";

const MAX_DELIVERY_ATTEMPTS = 3;

/**
 * A delivery is claimed by flipping its status to "processing" before the HTTP
 * request is made. If the final status write fails after that claim (process
 * kill, DB blip, worker crash), nothing ever looks at the row again and the
 * delivery is dropped forever. A delivery attempt itself is capped at
 * DELIVERY_TIMEOUT_MS (10s), so anything still "processing" well past that was
 * orphaned by a failed final write.
 */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Return deliveries stuck in "processing" to the pending pool so the normal
 * claim-and-deliver path can retry them. Deliveries that have already burned
 * every attempt are marked failed instead of being retried forever.
 */
export async function reclaimStuckWebhookDeliveries(
  prismaClient = prisma,
  now = new Date(),
  timeoutMs: number = Number(
    process.env.WEBHOOK_PROCESSING_TIMEOUT_MS ?? DEFAULT_PROCESSING_TIMEOUT_MS,
  ),
): Promise<number> {
  const stuckBefore = new Date(now.getTime() - timeoutMs);

  // updatedAt is bumped by the claim write, so it marks when processing began.
  const stuck = await prismaClient.webhookDelivery.findMany({
    where: { status: "processing", updatedAt: { lte: stuckBefore } },
    select: { id: true, attemptCount: true },
    take: 100,
  });

  if (stuck.length === 0) return 0;

  const exhausted = stuck.filter(
    (d) => d.attemptCount >= MAX_DELIVERY_ATTEMPTS,
  );
  const retryable = stuck.filter((d) => d.attemptCount < MAX_DELIVERY_ATTEMPTS);

  if (exhausted.length > 0) {
    await prismaClient.webhookDelivery.updateMany({
      where: { id: { in: exhausted.map((d) => d.id) }, status: "processing" },
      data: {
        status: "failed",
        nextRetryAt: null,
        lastError:
          "Delivery stuck in processing and reclaimed after max attempts",
      },
    });
  }

  let reclaimed = 0;
  for (const delivery of retryable) {
    // Still guarded on status: a row that finished between the read and this
    // write must not be dragged back into pending.
    const result = await prismaClient.webhookDelivery.updateMany({
      where: {
        id: delivery.id,
        status: "processing",
        updatedAt: { lte: stuckBefore },
      },
      data: {
        status: "pending",
        nextRetryAt: now,
        lastError: "Delivery reclaimed after being stuck in processing",
      },
    });
    reclaimed += result.count;
  }

  if (reclaimed > 0 || exhausted.length > 0) {
    logger.warn(
      { reclaimed, failed: exhausted.length, timeoutMs },
      "Reclaimed webhook deliveries stuck in processing",
    );
    Metrics.webhookDeliveryErrors();
  }

  return reclaimed + exhausted.length;
}

/**
 * Process a single webhook delivery
 */
async function processDelivery(
  delivery: any,
  prismaClient: typeof prisma,
  deliver: typeof deliverWebhook,
) {
  // The claim timestamp identifies this attempt: a reclaim and re-claim by
  // another worker bumps updatedAt, so a late final write from here no-ops.
  const claimedAt = new Date();
  const claimed = await prismaClient.webhookDelivery.updateMany({
    where: { id: delivery.id, status: "pending" },
    data: { status: "processing", updatedAt: claimedAt },
  });
  if (claimed.count === 0) return;
  const ownClaim = { id: delivery.id, status: "processing", updatedAt: claimedAt };

  const payload = delivery.payload as Record<string, unknown>;
  const result = await deliver(
    delivery.webhook.url,
    delivery.webhook.signingKey,
    payload,
  );

  if (result.status === "success") {
    await prismaClient.webhookDelivery.updateMany({
      where: ownClaim,
      data: {
        status: "success",
        attemptCount: delivery.attemptCount + 1,
        lastError: null,
      },
    });
    logger.info(
      {
        deliveryId: delivery.id,
        webhookId: delivery.webhookId,
        statusCode: result.statusCode,
      },
      "Webhook delivered successfully",
    );
    Metrics.webhooksDelivered();
  } else {
    const nextAttempt = delivery.attemptCount + 1;
    const willRetry = result.willRetry && shouldRetry(nextAttempt);

    let nextRetryAt: Date | null = null;
    if (willRetry) {
      const delayMs = getNextRetryDelay(delivery.attemptCount);
      if (delayMs !== null) {
        nextRetryAt = new Date(Date.now() + delayMs);
      }
    }

    await prismaClient.webhookDelivery.updateMany({
      where: ownClaim,
      data: {
        status: willRetry ? "pending" : "failed",
        attemptCount: nextAttempt,
        nextRetryAt,
        lastError: result.error,
      },
    });

    logger.warn(
      {
        deliveryId: delivery.id,
        webhookId: delivery.webhookId,
        attempt: nextAttempt,
        nextRetryAt,
        error: result.error,
      },
      willRetry
        ? "Webhook delivery failed, scheduled retry"
        : "Webhook delivery failed permanently",
    );
    if (willRetry) {
      Metrics.webhookRetries();
    }
    Metrics.webhookDeliveryErrors();
  }
}

export async function processPendingWebhookDeliveries(
  prismaClient = prisma,
  deliver = deliverWebhook,
  concurrency: number = Number(process.env.WEBHOOK_CONCURRENCY ?? 5),
) {
  const now = new Date();

  const pendingDeliveries = await prismaClient.webhookDelivery.findMany({
    where: {
      status: "pending",
      nextRetryAt: { lte: now },
      attemptCount: { lt: MAX_DELIVERY_ATTEMPTS },
    },
    include: {
      webhook: true,
    },
    take: 50,
  });

  // Process deliveries with bounded concurrency to prevent head-of-line blocking
  // Issue #1357: One slow endpoint shouldn't delay the entire batch
  // A zero, negative or NaN concurrency would never advance the loop below and
  // freeze the event loop, so clamp it to at least 1.
  const step = Math.max(1, Math.floor(concurrency) || 1);
  const chunks: (typeof pendingDeliveries)[] = [];
  for (let i = 0; i < pendingDeliveries.length; i += step) {
    chunks.push(pendingDeliveries.slice(i, i + step));
  }

  for (const chunk of chunks) {
    await Promise.allSettled(
      chunk.map((delivery) => processDelivery(delivery, prismaClient, deliver)),
    );
  }
}

export type WebhookProcessorHandle = {
  stop(): Promise<void>;
};

let processorInterval: ReturnType<typeof setInterval> | null = null;
let processorInFlight: Promise<void> | null = null;
let processorStopped = true;

type ProcessorOptions = {
  redisAvailable?: boolean;
  intervalMs?: number;
  processPending?: typeof processPendingWebhookDeliveries;
  reclaimStuck?: typeof reclaimStuckWebhookDeliveries;
  startQueue?: typeof createWebhookQueue;
  startWorker?: typeof createWebhookWorker;
};

export function startWebhookProcessor(
  options: ProcessorOptions = {},
): WebhookProcessorHandle {
  const redisAvailable = options.redisAvailable ?? getIsRedisAvailable();
  const processPending =
    options.processPending ?? processPendingWebhookDeliveries;
  const reclaimStuck = options.reclaimStuck ?? reclaimStuckWebhookDeliveries;
  const interval =
    options.intervalMs ??
    Number(process.env.WEBHOOK_PROCESSOR_INTERVAL_MS ?? 10000);

  if (redisAvailable) {
    logger.info("Redis available — starting BullMQ webhook queue");
    (options.startQueue ?? createWebhookQueue)();
    (options.startWorker ?? createWebhookWorker)();
  }

  // SQL-scheduled retries must still be swept when Redis is available, so
  // BullMQ and the poller share the same atomic status claim.
  logger.info(
    { interval, redisAvailable },
    "Starting DB-polled webhook processor",
  );
  processorStopped = false;

  const runSweep = () => {
    if (processorInFlight) return;
    processorInFlight = Promise.resolve()
      // Reclaim first: rows orphaned in "processing" by a failed final write
      // must go back to pending before this tick selects anything (#1351).
      .then(() => reclaimStuck())
      .then(() => processPending())
      .catch((err) => {
        logger.error({ err }, "Error in webhook processor run");
      })
      .finally(() => {
        processorInFlight = null;
      });
  };

  processorInterval = setInterval(runSweep, interval);

  return {
    async stop() {
      if (processorStopped) return;
      processorStopped = true;
      if (processorInterval) {
        clearInterval(processorInterval);
        processorInterval = null;
      }
      if (processorInFlight) {
        await processorInFlight;
      }
      if (redisAvailable) {
        await stopWebhookQueue();
      }
      logger.info("Webhook processor stopped.");
    },
  };
}
