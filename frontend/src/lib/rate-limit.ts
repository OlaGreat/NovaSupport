export type RateLimitInfo = {
  resetAt: Date | null;
  limit: number | null;
  remaining: number | null;
};

function parseNumber(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Values this large are absolute epoch timestamps (ms or s). Anything smaller
// is delta-seconds from now, which is what the RateLimit header draft defines
// for `ratelimit-reset`. Treating a delta such as 60 as an epoch made the
// reset time January 1970.
const EPOCH_MS_FLOOR = 1e12;
const EPOCH_SECONDS_FLOOR = 1e9;

function parseRateLimitReset(value: number, nowMs: number): Date {
  if (value >= EPOCH_MS_FLOOR) return new Date(value);
  if (value >= EPOCH_SECONDS_FLOOR) return new Date(value * 1000);
  return new Date(nowMs + value * 1000);
}

export function parseRateLimitInfo(headers: Headers): RateLimitInfo {
  const limit = parseNumber(headers.get("ratelimit-limit"));
  const remaining = parseNumber(headers.get("ratelimit-remaining"));

  let resetAt: Date | null = null;

  const retryAfterRaw = headers.get("retry-after");
  const retryAfterSeconds = parseNumber(retryAfterRaw);
  if (typeof retryAfterSeconds === "number") {
    resetAt = new Date(Date.now() + retryAfterSeconds * 1000);
  } else if (retryAfterRaw) {
    const retryAfterDate = Date.parse(retryAfterRaw);
    resetAt = Number.isNaN(retryAfterDate) ? null : new Date(retryAfterDate);
  }

  if (!resetAt) {
    const resetValue = parseNumber(headers.get("ratelimit-reset"));
    if (typeof resetValue === "number" && resetValue >= 0) {
      resetAt = parseRateLimitReset(resetValue, Date.now());
    }
  }

  return { resetAt, limit, remaining };
}

export function formatRateLimitedMessage(info: RateLimitInfo): string {
  if (!info.resetAt || Number.isNaN(info.resetAt.getTime())) {
    return "Rate limited. Please try again shortly.";
  }

  const time = info.resetAt.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Rate limited until ${time}. Please try again later.`;
}

