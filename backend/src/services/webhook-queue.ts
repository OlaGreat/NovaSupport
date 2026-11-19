import { Queue, Worker } from "bullmq";
import { getRedisClient, getIsRedisAvailable } from "./redis.js";
import { prisma } from "../db.js";
import { logger } from "../logger.js";
import { deliverWebhook, shouldRetry, getNextRetryDelay } from "./webhook.js";
import { Metrics } from "../metrics.js";

const QUEUE_NAME = "webhook-delivery";
const MAX_DELIVERY_ATTEMPTS = 3;

let queue: Queue | null = null;
let worker: Worker | null = null;

export interface WebhookJobData {
  deliveryId: string;
  webhookId: string;
  url: string;
  signingKey: string;
  payload: Record<string, unknown>;
}

type QueueOptions = ConstructorParameters<typeof Queue>[1];
type WorkerProcessor = ConstructorParameters<typeof Worker>[1];
type WorkerOptions = ConstructorParameters<typeof Worker>[2];

/**
 * Optional seams so the re-entrancy guard can be exercised without a live
 * Redis/BullMQ instance. Production callers omit them.
 */
export interface WebhookQueueDependencies {
  isRedisAvailable?: () => boolean;
  createQueue?: (name: string, options: QueueOptions) => Queue;
}

export interface WebhookWorkerDependencies {
  isRedisAvailable?: () => boolean;
  createWorker?: (name: string, processor: WorkerProcessor, options: WorkerOptions) => Worker;
}

export function createWebhookQueue(
  dependencies: WebhookQueueDependencies = {},
): Queue | null {
  const isRedisAvailable = dependencies.isRedisAvailable ?? getIsRedisAvailable;
  if (!isRedisAvailable()) return null;

  // Re-entrancy guard: a second call must not overwrite the existing queue.
  // Overwriting the module-level reference would leak the previous instance's
  // Redis connections, which are never closed. Return the live instance so
  // callers are idempotent (#1352).
  if (queue) return queue;

  const buildQueue =
    dependencies.createQueue ?? ((name, options) => new Queue(name, options));
  const redis = getRedisClient()!;
  queue = buildQueue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 50 },
    },
  });

  logger.info("BullMQ webhook delivery queue created");
  return queue;
}

export function getWebhookQueue(): Queue | null {
  return queue;
}

export async function enqueueWebhookDelivery(deliveryId: string): Promise<void> {
  if (!queue) return;

  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: { webhook: true },
  });

  if (!delivery) {
    logger.warn({ deliveryId }, "Webhook delivery not found, skipping enqueue");
    return;
  }

  const payload = delivery.payload as Record<string, unknown>;

  await queue.add(
    "deliver",
    {
      deliveryId: delivery.id,
      webhookId: delivery.webhookId,
      url: delivery.webhook.url,
      signingKey: delivery.webhook.signingKey,
      payload,
    } satisfies WebhookJobData,
    {
      jobId: delivery.id,
    },
  );

  logger.debug({ deliveryId, webhookId: delivery.webhookId }, "Webhook delivery enqueued");
}

export function createWebhookWorker(
  dependencies: WebhookWorkerDependencies = {},
): Worker | null {
  const isRedisAvailable = dependencies.isRedisAvailable ?? getIsRedisAvailable;
  if (!isRedisAvailable()) return null;

  // Re-entrancy guard: a second call must not overwrite the existing worker.
  // The previous Worker keeps consuming jobs concurrently with the new one and
  // its connections are never closed, so return the live instance instead
  // (#1352).
  if (worker) return worker;

  const buildWorker =
    dependencies.createWorker ??
    ((name, processor, options) => new Worker(name, processor, options));
  const redis = getRedisClient()!;
  worker = buildWorker(
    QUEUE_NAME,
    async (job) => {
      const { deliveryId, webhookId, url, signingKey, payload } = job.data as WebhookJobData;

      // Atomically claim the row; claimedAt guards the final write (#1501)
      const claimedAt = new Date();
      const claimed = await prisma.webhookDelivery.updateMany({
        where: { id: deliveryId, status: "pending" },
        data: { status: "processing", updatedAt: claimedAt },
      });

      if (claimed.count === 0) {
        logger.debug({ deliveryId }, "Delivery already claimed, skipping");
        return;
      }

      const result = await deliverWebhook(url, signingKey, payload);

      if (result.status === "success") {
        await prisma.webhookDelivery.updateMany({
          where: { id: deliveryId, status: "processing", updatedAt: claimedAt },
          data: {
            status: "success",
            attemptCount: job.attemptsMade + 1,
            lastError: null,
          },
        });
        logger.info(
          { deliveryId, webhookId, statusCode: result.statusCode },
          "Webhook delivered successfully",
        );
        Metrics.webhooksDelivered();
      } else {
        const nextAttempt = job.attemptsMade + 1;
        const willRetry = result.willRetry && shouldRetry(nextAttempt);

        let nextRetryAt: Date | null = null;
        if (willRetry) {
          const delayMs = getNextRetryDelay(job.attemptsMade);
          if (delayMs !== null) {
            nextRetryAt = new Date(Date.now() + delayMs);
          }
        }

        await prisma.webhookDelivery.updateMany({
          where: { id: deliveryId, status: "processing", updatedAt: claimedAt },
          data: {
            status: willRetry ? "pending" : "failed",
            attemptCount: nextAttempt,
            nextRetryAt,
            lastError: result.error,
          },
        });

        logger.warn(
          {
            deliveryId,
            webhookId,
            attempt: nextAttempt,
            nextRetryAt,
            error: result.error,
          },
          willRetry ? "Webhook delivery failed, scheduled retry" : "Webhook delivery failed permanently",
        );
        if (willRetry) {
          Metrics.webhookRetries();
        }
        Metrics.webhookDeliveryErrors();

        if (!willRetry) {
          throw new Error(`Permanent failure: ${result.error}`);
        }
      }
    },
    {
      connection: redis,
      concurrency: 5,
      limiter: {
        max: 10,
        duration: 1000,
      },
    },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "Webhook delivery job failed");
  });

  worker.on("completed", (job) => {
    logger.debug({ jobId: job.id }, "Webhook delivery job completed");
  });

  logger.info("BullMQ webhook worker started (concurrency: 5)");
  return worker;
}

export async function stopWebhookQueue(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}
