import { getRedisClient, getIsRedisAvailable } from "./redis.js";

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
const CACHE_KEY_PREFIX = "lb:";

// In-process fallback cache
const leaderboardCache = new Map<string, CachedLeaderboard>();

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
    expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000,
    value,
  });
}

export async function invalidateProfileLeaderboardCache(profileId: string): Promise<void> {
  if (getIsRedisAvailable()) {
    const redis = getRedisClient()!;
    try {
      const pattern = `${CACHE_KEY_PREFIX}${profileId}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {
      // Redis error handled below — in-process cache is always invalidated
    }
  }

  // Always clear the in-process fallback cache regardless of the Redis path,
  // so a stale entry can never be served after this call reports success.
  invalidateInProcessCache(profileId);
}

function invalidateInProcessCache(profileId: string): void {
  const prefix = `${profileId}:`;
  for (const key of leaderboardCache.keys()) {
    if (key.startsWith(prefix)) {
      leaderboardCache.delete(key);
    }
  }
}
