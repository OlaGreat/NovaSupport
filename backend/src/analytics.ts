import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";

const analyticsCache = new Map<
  string,
  { data: any; timestamp: number }
>();
const CACHE_TTL = 3600000; // 1 hour
const CACHE_MAX_SIZE = 1000; // Maximum number of cache entries

interface DailyContribution {
  date: string;
  amount: string;
  count: number;
  uniqueContributors: number;
  avgContribution: string;
}

function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_TTL;
}

export async function getAnalytics(
  profileId: string,
  startDate?: Date,
  endDate?: Date,
  format?: "json" | "csv"
) {
  const start = startDate || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endDate || new Date();

  const cacheKey = `${profileId}:${start.toISOString()}:${end.toISOString()}:${format}`;
  const cached = analyticsCache.get(cacheKey);

  if (cached && isCacheValid(cached.timestamp)) {
    return format === "csv" ? convertToCSV(cached.data) : cached.data;
  }

  // Aggregate in the database rather than loading every row into memory.
  // SUM is computed by Postgres on the Decimal column, preserving precision
  // (no Number() conversion), and only one row per day is returned.
  const [dailyRows, summaryAgg, contributorRows, assetGroups] =
    await Promise.all([
      prisma.$queryRaw<
        {
          date: string;
          total: string | null;
          txCount: number;
          uniqueContributors: number;
        }[]
      >`
        SELECT
          to_char("createdAt", 'YYYY-MM-DD') AS date,
          SUM("amount")::text AS total,
          COUNT(*)::int AS "txCount",
          COUNT(DISTINCT "supporterAddress")::int AS "uniqueContributors"
        FROM "SupportTransaction"
        WHERE "profileId" = ${profileId}
          AND "createdAt" >= ${start}
          AND "createdAt" <= ${end}
          AND "status" = 'SUCCESS'
        GROUP BY 1
        ORDER BY 1 ASC
      `,
      prisma.supportTransaction.aggregate({
        where: { profileId, status: "SUCCESS", createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.$queryRaw<{ count: number }[]>`
        SELECT COUNT(DISTINCT "supporterAddress")::int AS count
        FROM "SupportTransaction"
        WHERE "profileId" = ${profileId}
          AND "createdAt" >= ${start}
          AND "createdAt" <= ${end}
          AND "status" = 'SUCCESS'
      `,
      prisma.supportTransaction.groupBy({
        by: ["assetCode"],
        where: { profileId, status: "SUCCESS", createdAt: { gte: start, lte: end } },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

  // Per-day metrics, keeping amounts as decimal strings.
  const dailyData: DailyContribution[] = dailyRows.map((row) => {
    // Normalize Postgres numeric text (e.g. "150.0000000") to "150".
    const amount =
      row.total != null ? new Prisma.Decimal(row.total).toString() : "0";
    const avgContribution =
      row.txCount > 0
        ? new Prisma.Decimal(amount).div(row.txCount).toString()
        : "0";
    return {
      date: row.date,
      amount,
      count: row.txCount,
      uniqueContributors: row.uniqueContributors,
      avgContribution,
    };
  });

  // Fill gaps. The SQL buckets rows by UTC calendar day, so the walk must step
  // through UTC days too (#1496).
  const filledData: DailyContribution[] = [];

  const dataMap = new Map(dailyData.map((d) => [d.date, d]));

  for (const day of utcDaysInRange(start, end)) {
    const dateStr = day.toISOString().split("T")[0];
    const existing = dataMap.get(dateStr);

    filledData.push(
      existing || {
        date: dateStr,
        amount: "0",
        count: 0,
        uniqueContributors: 0,
        avgContribution: "0",
      }
    );
  }

  // Calculate summary using Decimal arithmetic to avoid precision loss.
  const totalAmount = (
    summaryAgg._sum.amount ?? new Prisma.Decimal(0)
  ).toString();
  const totalContributors = contributorRows[0]?.count ?? 0;
  const avgDailyContribution =
    filledData.length > 0
      ? new Prisma.Decimal(totalAmount).div(filledData.length).toString()
      : "0";

  const result = {
    profileId,
    summary: {
      totalRaised: totalAmount,
      totalContributors,
      avgDailyContribution,
      transactionCount: summaryAgg._count,
      dateRange: { start: start.toISOString(), end: end.toISOString() },
    },
    dailyContributions: filledData,
    assetBreakdown: assetGroups.map((group) => ({
      asset: group.assetCode,
      amount: (group._sum.amount ?? new Prisma.Decimal(0)).toString(),
      count: group._count,
    })),
  };

  analyticsCache.set(cacheKey, { data: result, timestamp: Date.now() });

  // Evict the oldest 20% of entries when the cache exceeds max size to
  // prevent OOM. A single-entry eviction (the previous behavior, see #950)
  // can't keep up when writes arrive faster than one-at-a-time removal, so
  // this removes a whole batch in one pass. Map iteration order is
  // insertion order, so the first N keys are the oldest.
  if (analyticsCache.size > CACHE_MAX_SIZE) {
    const evictCount = Math.max(1, Math.floor(CACHE_MAX_SIZE * 0.2));
    const keysToEvict = Array.from(analyticsCache.keys()).slice(0, evictCount);
    for (const key of keysToEvict) {
      analyticsCache.delete(key);
    }
  }

  if (format === "csv") {
    return convertToCSV(result);
  }

  return result;
}

function convertToCSV(analytics: any): string {
  const headers = [
    "Date",
    "Amount",
    "Transaction Count",
    "Unique Contributors",
    "Avg Contribution",
  ];
  const rows = analytics.dailyContributions.map(
    (d: DailyContribution) => [
      d.date,
      d.amount,
      d.count,
      d.uniqueContributors,
      d.avgContribution,
    ]
  );

  const csv =
    [headers, ...rows]
      .map((row) => row.map((cell: unknown) => `"${cell}"`).join(","))
      .join("\n") + "\n";

  return csv;
}

interface GapFillInput {
  date: Date;
  total: number | string | bigint;
  txCount: number | string | bigint;
  uniqueContributors?: number | string | bigint;
  avgContribution?: number | string | bigint;
}

interface GapFillOutput {
  date: Date;
  amount: string;
  count: number;
  uniqueContributors: number;
  avgContribution: string;
}

/**
 * Midnight UTC of every calendar day from `start`'s UTC day through `end`.
 *
 * Daily buckets come from UTC date truncation in SQL, so the walk steps in UTC.
 * Stepping with local-time `setDate` breaks when the server is not on UTC: a
 * DST change makes a "day" 23 or 25 hours long, so the UTC label it lands on
 * can repeat or skip a date (#1496).
 */
export function utcDaysInRange(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  while (cursor <= end) {
    days.push(new Date(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export function fillGaps(
  results: GapFillInput[],
  period: string,
  from: Date,
  to: Date,
): { data: GapFillOutput[]; period: string } {
  const dataMap = new Map<string, GapFillInput>();
  for (const row of results) {
    const d = row.date instanceof Date ? row.date : new Date(row.date);
    let key: string;
    if (period === "monthly") {
      key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    } else if (period === "weekly") {
      const startOfWeek = new Date(d);
      startOfWeek.setDate(d.getDate() - d.getDay());
      key = startOfWeek.toISOString().split("T")[0];
    } else {
      key = d.toISOString().split("T")[0];
    }
    dataMap.set(key, row);
  }

  const filled: GapFillOutput[] = [];
  // Daily buckets are UTC days (DATE_TRUNC('day')), so start on one (#1496).
  const cursor =
    period === "monthly" || period === "weekly"
      ? new Date(from)
      : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));

  while (cursor <= to) {
    let key: string;
    let nextCursor: Date;

    if (period === "monthly") {
      key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      nextCursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    } else if (period === "weekly") {
      const startOfWeek = new Date(cursor);
      startOfWeek.setDate(cursor.getDate() - cursor.getDay());
      key = startOfWeek.toISOString().split("T")[0];
      nextCursor = new Date(cursor);
      nextCursor.setDate(cursor.getDate() + 7);
    } else {
      key = cursor.toISOString().split("T")[0];
      nextCursor = new Date(cursor);
      nextCursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const existing = dataMap.get(key);
    if (existing) {
      const total = Number(existing.total);
      const count = Number(existing.txCount);
      const uniqueContributors = existing.uniqueContributors != null
        ? Number(existing.uniqueContributors)
        : 0;
      const avgContribution = existing.avgContribution != null
        ? String(existing.avgContribution)
        : count > 0
          ? String(total / count)
          : "0";
      filled.push({
        date: new Date(cursor),
        amount: String(total),
        count,
        uniqueContributors,
        avgContribution,
      });
    } else {
      filled.push({
        date: new Date(cursor),
        amount: "0",
        count: 0,
        uniqueContributors: 0,
        avgContribution: "0",
      });
    }

    cursor.setTime(nextCursor.getTime());
  }

  return { data: filled, period };
}

export function clearAnalyticsCache(profileId?: string): void {
  if (profileId) {
    Array.from(analyticsCache.keys())
      .filter((key) => key.startsWith(profileId))
      .forEach((key) => analyticsCache.delete(key));
  } else {
    analyticsCache.clear();
  }
}
