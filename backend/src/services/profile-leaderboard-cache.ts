import { getRedisClient, getRedisSubscriber, getIsRedisAvailable } from "./redis.js";
import { logger } from "../logger.js";

export type LeaderboardSort = "total_amount" | "transaction_count";

export type LeaderboardEntry = {
  rank: number;
  supporterAddress: string;
  assetCode: string;
  totalAmount: string;
  transactionCount: number;
};

export type LeaderboardResponse = {
  leaderboard: LeaderboardEntry[];
  total: number;
  limit: number;
  offset: number;
  sort: LeaderboardSort;
};

type CachedLeaderboard = {
  expiresAt: number;
  value: LeaderboardResponse;
};

const CACHE_TTL_SECONDS = 5 * 60;
// The in-process fallback is only populated when a Redis op failed, so it cannot
// be invalidated by other replicas. Keep its TTL short so a replica that missed
// a broadcast cannot serve a stale leaderboard for long (#1350).
const FALLBACK_CACHE_TTL_SECONDS = 30;
const CACHE_KEY_PREFIX = "lb:";
const INVALIDATION_CHANNEL = "lb:invalidate";

// In-process fallback cache
const leaderboardCache = new Map<string, CachedLeaderboard>();

let invalidationSubscriptionStarted = false;
let invalidationSubscriptionPending = false;
let invalidationListenerAttached = false;

/**
 * Listen for invalidation broadcasts from other replicas so their local
 * fallback caches are dropped too. Idempotent and best-effort: if Redis or the
 * subscriber is unavailable, the short fallback TTL is the backstop.
 */
function ensureInvalidationSubscription(): void {
  if (invalidationSubscriptionStarted || invalidationSubscriptionPending) return;

  const subscriber = getRedisSubscriber();
  if (!subscriber) return;

  try {
    if (!invalidationListenerAttached) {
      subscriber.on("message", (channel: string, message: string) => {
        if (channel !== INVALIDATION_CHANNEL) return;
        const profileId = message.trim();
        if (!profileId) return;
        applyLeaderboardInvalidationBroadcast(profileId);
      });
      invalidationListenerAttached = true;
    }
    invalidationSubscriptionPending = true;
    subscriber
      .subscribe(INVALIDATION_CHANNEL)
      .then(() => {
        invalidationSubscriptionStarted = true;
      })
      .catch((err: Error) => {
        // Leave the started flag false so the next cache access retries.
        logger.warn({ err }, "Failed to subscribe to leaderboard invalidation channel; will retry");
      })
      .finally(() => {
        invalidationSubscriptionPending = false;
      });
  } catch (err) {
    invalidationSubscriptionPending = false;
    logger.warn({ err }, "Failed to start leaderboard invalidation subscription");
  }
}

async function broadcastInvalidation(profileId: string): Promise<void> {
  const publisher = getRedisClient();
  if (!publisher) return;
  try {
    await publisher.publish(INVALIDATION_CHANNEL, profileId);
  } catch {
    // Broadcast is best-effort; other replicas fall back to their short TTL.
  }
}

function cacheKey(profileId: string, limit: number, offset: number, sort: LeaderboardSort) {
  return `${profileId}:${limit}:${offset}:${sort}`;
}

function redisKey(key: string) {
  return `${CACHE_KEY_PREFIX}${key}`;
}

export async function getCachedLeaderboard(
  profileId: string,
  limit: number,
  offset: number,
  sort: LeaderboardSort,
): Promise<LeaderboardResponse | null> {
  const key = cacheKey(profileId, limit, offset, sort);

  ensureInvalidationSubscription();

  if (getIsRedisAvailable()) {
    const redis = getRedisClient()!;
    try {
      const raw = await redis.get(redisKey(key));
      if (raw) return JSON.parse(raw) as LeaderboardResponse;
      return null;
    } catch {
      return getInProcessCache(key);
    }
  }

  return getInProcessCache(key);
}

function getInProcessCache(key: string): LeaderboardResponse | null {
  const cached = leaderboardCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    leaderboardCache.delete(key);
    return null;
  }
  return cached.value;
}

export async function setCachedLeaderboard(
  profileId: string,
  limit: number,
  offset: number,
  sort: LeaderboardSort,
  value: LeaderboardResponse,
): Promise<void> {
  const key = cacheKey(profileId, limit, offset, sort);

  ensureInvalidationSubscription();

  if (getIsRedisAvailable()) {
    const redis = getRedisClient()!;
    try {
      await redis.setex(redisKey(key), CACHE_TTL_SECONDS, JSON.stringify(value));
    } catch {
      setInProcessCache(key, value);
    }
    return;
  }

  setInProcessCache(key, value);
}

function setInProcessCache(key: string, value: LeaderboardResponse): void {
  leaderboardCache.set(key, {
    expiresAt: Date.now() + FALLBACK_CACHE_TTL_SECONDS * 1000,
    value,
  });
}

export async function invalidateProfileLeaderboardCache(profileId: string): Promise<void> {
  if (getIsRedisAvailable()) {
    const redis = getRedisClient()!;
    try {
      const pattern = `${CACHE_KEY_PREFIX}${profileId}:*`;
      let cursor = "0";
      do {
        const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 100);
        cursor = result[0];
        const keys = result[1];
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      } while (cursor !== "0");
    } catch {
      // Redis error handled below — in-process cache is always invalidated
    }
  }

  // Always clear the in-process fallback cache regardless of the Redis path,
  // so a stale entry can never be served after this call reports success.
  invalidateInProcessCache(profileId);

  // Other replicas can only clear their own fallback caches, so tell them to
  // drop theirs (#1350). Published after the local clear so this replica's own
  // state is correct regardless of whether the broadcast succeeds.
  await broadcastInvalidation(profileId);
}

function invalidateInProcessCache(profileId: string): void {
  const prefix = `${profileId}:`;
  for (const key of leaderboardCache.keys()) {
    if (key.startsWith(prefix)) {
      leaderboardCache.delete(key);
    }
  }
}

/**
 * Apply an invalidation broadcast received from another replica. Exported so
 * the broadcast handler and tests exercise the same code path.
 */
export function applyLeaderboardInvalidationBroadcast(profileId: string): void {
  if (!profileId) return;
  invalidateInProcessCache(profileId);
}
