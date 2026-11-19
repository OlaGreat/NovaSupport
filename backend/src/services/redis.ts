// ioredis ships CJS types; the ESM default import resolves at runtime via tsx.
// We use `any` for the Redis client type to avoid the CJS/ESM type mismatch.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RedisClient = any;

import IORedis from "ioredis";
import { logger } from "../logger.js";

let client: RedisClient | null = null;
let subscriber: RedisClient | null = null;
let isRedisAvailable = false;

function createRedisClient(): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url) {
    logger.info("REDIS_URL not set — using in-process cache fallback");
    return null;
  }

  try {
    const IORedisClass = (IORedis as any).default ?? IORedis;
    const redis = new IORedisClass(url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times: number) {
        // Allow much longer retry periods to survive Redis maintenance windows
        if (times > 50) return null; // Stop after ~50 attempts (~100 seconds total)
        return Math.min(times * 200, 2000); // Exponential backoff up to 2s
      },
      enableReadyCheck: true,
      lazyConnect: true,
    });

    redis.on("error", (err: Error) => {
      logger.warn({ err }, "Redis connection error — falling back to in-process cache");
      isRedisAvailable = false;
    });

    redis.on("connect", () => {
      isRedisAvailable = true;
      logger.info("Redis connected");
    });

    redis.on("close", () => {
      isRedisAvailable = false;
    });

    return redis;
  } catch (err) {
    logger.warn({ err }, "Failed to create Redis client — using in-process cache fallback");
    return null;
  }
}

export async function connectRedis(): Promise<void> {
  client = createRedisClient();
  if (!client) return;

  // If the timeout wins, the abandoned connect may still reject later; log it
  // instead of leaving an unhandled rejection that can crash the process.
  const connecting = client.connect();
  connecting.catch((err: unknown) => {
    logger.warn({ err }, "Redis connect attempt failed after timeout");
  });

  try {
    await Promise.race([
      connecting,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Redis connection timeout")), 5000),
      ),
    ]);
    isRedisAvailable = true;
  } catch (err) {
    logger.warn({ err }, "Redis failed to connect within 5s — using in-process cache fallback");
    isRedisAvailable = false;
  }
}

export function getRedisClient(): RedisClient {
  return client;
}

/**
 * A second connection dedicated to pub/sub. Redis connections in subscribe mode
 * cannot serve normal commands, so this is a duplicate of the main client and
 * is only used for cross-replica cache invalidation broadcasts.
 *
 * Returns null when Redis is unavailable or the subscriber cannot be created —
 * callers must treat that as "no broadcast available" and degrade to their
 * local cache TTL.
 */
export function getRedisSubscriber(): RedisClient {
  if (subscriber) return subscriber;
  if (!client) return null;

  try {
    const sub = client.duplicate();
    sub.on("error", (err: Error) => {
      logger.warn({ err }, "Redis subscriber error — invalidation broadcasts disabled");
    });
    // A subscriber is a separate connection; connect lazily and swallow failures
    // so a broadcast outage never breaks the request path.
    sub.connect?.()?.catch?.((err: Error) => {
      logger.warn({ err }, "Redis subscriber failed to connect");
    });
    subscriber = sub;
    return subscriber;
  } catch (err) {
    logger.warn({ err }, "Failed to create Redis subscriber");
    return null;
  }
}

export function disconnectRedisSubscriber(): void {
  if (subscriber) {
    subscriber.unsubscribe?.()?.catch?.(() => {});
    subscriber.quit?.()?.catch?.(() => {});
    subscriber = null;
  }
}

export function getIsRedisAvailable(): boolean {
  return isRedisAvailable && client !== null && client.status === "ready";
}

export async function disconnectRedis(): Promise<void> {
  disconnectRedisSubscriber();
  if (client) {
    await client.quit().catch(() => {});
    client = null;
    isRedisAvailable = false;
  }
}
