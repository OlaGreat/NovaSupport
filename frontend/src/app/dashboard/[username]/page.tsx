 "use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { ErrorBoundary } from "@/components/error-boundary";
import { API_BASE_URL } from "@/lib/config";
import { apiFetch } from "@/lib/api-client";
import { getStoredWalletAddress } from "@/lib/wallet-adapters";
import { getDominantAssetCode, type AssetAmount } from "@/lib/assets";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";
import {
  TrendingUp,
  Users,
  Wallet,
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Info,
} from "lucide-react";
import { motion } from "framer-motion";
import { formatRateLimitedMessage, parseRateLimitInfo } from "@/lib/rate-limit";

interface AnalyticsData {
  summary: {
    totalRaised: number;
    totalContributors: number;
    avgContribution: number;
    activeDrips: number;
  };
  dailyContributions: { date: string; amount: number }[];
  recentTransactions: {
    id: string;
    type: string;
    user: string;
    asset: string;
    amount: string;
    age: string;
  }[];
}

type ProfileSettings = {
  walletAddress: string;
  email?: string | null;
  emailVerified?: boolean;
  notifyOnSupport?: boolean;
};

type ChartPoint = {
  date: string;
  amount: number;
};

type ChartRange = "7D" | "30D" | "90D";

const COLORS = ["#00FFC2", "#00E0FF", "#FFB800", "#FF4D4D", "#9D4EDD"];
const PERIOD_DAYS: Record<ChartRange, number> = {
  "7D": 7,
  "30D": 30,
  "90D": 90,
};

function toNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function toBool(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function timeAgo(value: string): string {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return "-";

  const diffMs = Date.now() - timestamp;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function formatChartDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;

  return parsed.toLocaleDateString("en-GB", {
    month: "short",
    day: "numeric",
  });
}

function getFromDate(period: ChartRange): string {
  const days = PERIOD_DAYS[period];
  const from = new Date();
  from.setDate(from.getDate() - days);
  return from.toISOString();
}

function normalizeAnalyticsResponse(json: unknown): AnalyticsData {
  const payload = (json ?? {}) as Record<string, unknown>;
  const summary = (payload.summary ?? {}) as Record<string, unknown>;

  const dailySource = (payload.dailyContributions ??
    payload.daily_contributions ??
    []) as unknown[];
  const txSource = (payload.recentTransactions ??
    payload.recent_transactions ??
    payload.transactions ??
    []) as unknown[];

  return {
    summary: {
      totalRaised: toNumber(
        summary.totalRaised ??
          summary.total_raised ??
          payload.totalRaised ??
          payload.total_raised,
      ),
      totalContributors: toNumber(
        summary.totalContributors ??
          summary.total_contributors ??
          payload.totalContributors ??
          payload.total_contributors,
      ),
      avgContribution: toNumber(
        summary.avgContribution ??
          summary.avg_contribution ??
          payload.avgContribution ??
          payload.avg_contribution,
      ),
      activeDrips: toNumber(
        summary.activeDrips ??
          summary.active_drips ??
          payload.activeDrips ??
          payload.active_drips,
      ),
    },
    dailyContributions: dailySource.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      return {
        date: toString(item.date, `Day ${index + 1}`),
        amount: toNumber(item.amount ?? item.totalAmount ?? item.total_amount),
      };
    }),
    recentTransactions: txSource.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      const txType = toString(
        item.type ?? item.supportType ?? item.support_type,
        "One-time",
      );
      const supporter = toString(
        item.user ??
          item.supporter ??
          item.supporterAddress ??
          item.supporter_address,
        "Unknown",
      );
      const amountValue = toNumber(
        item.amount ?? item.totalAmount ?? item.total_amount,
      );
      const createdAt = toString(item.createdAt ?? item.created_at, "");
      return {
        id: toString(item.id ?? item.txHash ?? item.tx_hash, `tx-${index}`),
        type: txType,
        user: supporter,
        asset: toString(item.asset ?? item.assetCode ?? item.asset_code, "XLM"),
        amount: amountValue.toFixed(7).replace(/\.?0+$/, "") || "0",
        age: timeAgo(createdAt),
      };
    }),
  };
}

function normalizeTimeseriesResponse(json: unknown): ChartPoint[] {
  const payload = (json ?? {}) as Record<string, unknown>;
  const source = (payload.points ??
    payload.data ??
    payload.series ??
    payload.dailyContributions ??
    payload.daily_contributions ??
    []) as unknown[];

  return source.map((entry, index) => {
    const item = entry as Record<string, unknown>;
    const rawDate = toString(
      item.date ??
        item.label ??
        item.periodStart ??
        item.period_start ??
        item.timestamp,
      `Point ${index + 1}`,
    );

    return {
      date: formatChartDate(rawDate),
      amount: toNumber(
        item.amount ??
          item.totalAmount ??
          item.total_amount ??
          item.value ??
          item.total,
      ),
    };
  });
}

type RecurringDrip = {
  id: string;
  profileId?: string;
  profileUsername?: string;
  profileDisplayName?: string;
  supporterAddress?: string;
  amount: string;
  assetCode: string;
  frequency: string;
  nextRunAt: string;
  status: string;
  createdAt: string;
};

export default function DashboardPage() {
  const { username } = useParams<{ username: string }>();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [chartData, setChartData] = useState<ChartPoint[]>([]);
  const [assetBreakdown, setAssetBreakdown] = useState<AssetAmount[]>(
    [],
  );
  const [selectedPeriod, setSelectedPeriod] = useState<ChartRange>("30D");
  const [chartLoading, setChartLoading] = useState(true);
  const [connectedWallet, setConnectedWallet] = useState("");
  const [csvLoading, setCsvLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resendingVerification, setResendingVerification] = useState(false);
  const [verificationBannerMsg, setVerificationBannerMsg] = useState<
    string | null
  >(null);
  const [verificationBannerType, setVerificationBannerType] = useState<
    "success" | "error"
  >("success");
  const [drips, setDrips] = useState<RecurringDrip[]>([]);
  const [dripsLoading, setDripsLoading] = useState(true);
  const [trends, setTrends] = useState({
    totalRaised: "—",
    totalRaisedPositive: true,
    txCount: "—",
    txCountPositive: true,
  });

  useEffect(() => {
    async function fetchData() {
      try {
        const [analyticsRes, profileRes, assetsRes] = await Promise.all([
          apiFetch(`${API_BASE_URL}/analytics/${username}`),
          apiFetch(`${API_BASE_URL}/profiles/${username}`),
          apiFetch(`${API_BASE_URL}/profiles/${username}/analytics/assets`),
        ]);
        if (!analyticsRes.ok) throw new Error("Failed to fetch analytics");
        if (!profileRes.ok) throw new Error("Failed to fetch profile settings");

        const json = await analyticsRes.json();
        const profileJson = (await profileRes.json()) as Record<
          string,
          unknown
        >;
        setData(normalizeAnalyticsResponse(json));
        setSettings({
          walletAddress: toString(profileJson.walletAddress),
          email: toString(profileJson.email, "") || null,
          emailVerified: toBool(profileJson.emailVerified, false),
          notifyOnSupport: toBool(profileJson.notifyOnSupport, true),
        });

        if (assetsRes.ok) {
          const assetsJson = (await assetsRes.json()) as {
            breakdown: AssetAmount[];
          };
          setAssetBreakdown(assetsJson.breakdown ?? []);
        }
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [username]);

  useEffect(() => {
    let cancelled = false;

    async function fetchChartData() {
      setChartLoading(true);

      try {
        const from = getFromDate(selectedPeriod);
        const response = await apiFetch(
          `${API_BASE_URL}/profiles/${username}/analytics/timeseries?period=daily&from=${encodeURIComponent(from)}`,
        );

        if (!response.ok) {
          throw new Error("Failed to fetch chart data");
        }

        const json = await response.json();
        if (!cancelled) {
          setChartData(normalizeTimeseriesResponse(json));
        }
      } catch {
        if (!cancelled) {
          setChartData([]);
        }
      } finally {
        if (!cancelled) {
          setChartLoading(false);
        }
      }
    }

    fetchChartData();

    return () => {
      cancelled = true;
    };
  }, [username, selectedPeriod]);

  // Re-read the connected wallet whenever it changes so ownership updates
  // without a reload (#1288). WalletConnect dispatches wallet-connected /
  // wallet-disconnected in this tab; `storage` covers changes from other tabs.
  useEffect(() => {
    function syncConnectedWallet() {
      setConnectedWallet(getStoredWalletAddress() ?? "");
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === null || event.key === "walletAddress") {
        syncConnectedWallet();
      }
    }

    syncConnectedWallet();
    window.addEventListener("wallet-connected", syncConnectedWallet);
    window.addEventListener("wallet-disconnected", syncConnectedWallet);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("wallet-connected", syncConnectedWallet);
      window.removeEventListener("wallet-disconnected", syncConnectedWallet);
      window.removeEventListener("storage", handleStorage);
    };
  }, []);

  // Fetch two consecutive 30-day periods and compute period-over-period trends (#517)
  useEffect(() => {
    async function fetchTrends() {
      try {
        const now = new Date();
        const periodEnd = now.toISOString();
        const periodStart = new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString();
        const prevStart = new Date(
          now.getTime() - 60 * 24 * 60 * 60 * 1000,
        ).toISOString();

        const [currRes, prevRes] = await Promise.all([
          apiFetch(
            `${API_BASE_URL}/profiles/${username}/analytics/timeseries?period=daily&from=${encodeURIComponent(periodStart)}&to=${encodeURIComponent(periodEnd)}`,
          ),
          apiFetch(
            `${API_BASE_URL}/profiles/${username}/analytics/timeseries?period=daily&from=${encodeURIComponent(prevStart)}&to=${encodeURIComponent(periodStart)}`,
          ),
        ]);

        if (!currRes.ok || !prevRes.ok) return;

        const [currJson, prevJson] = (await Promise.all([
          currRes.json(),
          prevRes.json(),
        ])) as [
          { data?: Array<{ amount: string; count: number }> },
          { data?: Array<{ amount: string; count: number }> },
        ];

        const sum = (
          arr: Array<{ amount: string; count: number }>,
          key: "amount" | "count",
        ) =>
          arr.reduce(
            (acc, d) => acc + (key === "amount" ? Number(d.amount) : d.count),
            0,
          );

        const currAmount = sum(currJson.data ?? [], "amount");
        const prevAmount = sum(prevJson.data ?? [], "amount");
        const currCount = sum(currJson.data ?? [], "count");
        const prevCount = sum(prevJson.data ?? [], "count");

        function formatTrend(
          curr: number,
          prev: number,
        ): { label: string; positive: boolean } {
          if (prev === 0)
            return curr === 0
              ? { label: "No change", positive: true }
              : { label: "+100%", positive: true };
          const pct = ((curr - prev) / prev) * 100;
          if (pct === 0) return { label: "No change", positive: true };
          const sign = pct > 0 ? "+" : "";
          return { label: `${sign}${pct.toFixed(1)}%`, positive: pct >= 0 };
        }

        const raisedTrend = formatTrend(currAmount, prevAmount);
        const countTrend = formatTrend(currCount, prevCount);

        setTrends({
          totalRaised: raisedTrend.label,
          totalRaisedPositive: raisedTrend.positive,
          txCount: countTrend.label,
          txCountPositive: countTrend.positive,
        });
      } catch {
        // leave defaults ("—")
      }
    }
    fetchTrends();
  }, [username]);

  const isOwner = Boolean(
    settings?.walletAddress &&
    connectedWallet &&
    settings.walletAddress === connectedWallet,
  );
  const isChartEmpty =
    chartData.length === 0 || chartData.every((point) => point.amount === 0);

  useEffect(() => {
    let cancelled = false;

    async function fetchDrips() {
      // Only the profile owner may see this profile's drips. Without a
      // profileId the endpoint falls back to the viewer's own pledges, which
      // must never be rendered on someone else's dashboard.
      if (!isOwner) {
        setDrips([]);
        setDripsLoading(false);
        return;
      }

      setDripsLoading(true);
      try {
        const res = await apiFetch(
          `${API_BASE_URL}/v1/recurring-support?profileId=${encodeURIComponent(username)}`,
        );

        if (!cancelled) {
          if (res.ok) {
            const json = await res.json();
            setDrips(Array.isArray(json) ? json : []);
          } else {
            setDrips([]);
          }
        }
      } catch {
        if (!cancelled) setDrips([]);
      } finally {
        if (!cancelled) setDripsLoading(false);
      }
    }

    fetchDrips();

    return () => {
      cancelled = true;
    };
  }, [username, isOwner]);

  async function handleDownloadCsv() {
    if (!isOwner) return;
    setCsvLoading(true);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/profiles/${username}/transactions/csv`,
      );
      if (!res.ok) {
        const rateLimitInfo = parseRateLimitInfo(res.headers);
        if (rateLimitInfo) {
          throw new Error(formatRateLimitedMessage(rateLimitInfo));
        }
        throw new Error("Failed to download CSV");
      }
      const csv = await res.text();
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `novasupport-transactions-${username}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setError(err.message ?? "Failed to download CSV");
    } finally {
      setCsvLoading(false);
    }
  }

  async function handleNotificationToggle(next: boolean) {
    if (!isOwner || !settings) return;
    const prev = settings.notifyOnSupport ?? true;
    setSettingsSaving(true);
    setSettings({ ...settings, notifyOnSupport: next });
    try {
      const res = await apiFetch(`${API_BASE_URL}/profiles/${username}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ notifyOnSupport: next }),
      });
      if (!res.ok) {
        throw new Error("Failed to save notification preference");
      }
    } catch (err: any) {
      setSettings({ ...settings, notifyOnSupport: prev });
      setError(err.message ?? "Failed to save setting");
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleResendVerification() {
    if (!isOwner) return;
    setResendingVerification(true);
    setVerificationBannerMsg(null);
    try {
      const res = await apiFetch(
        `${API_BASE_URL}/profiles/${username}/resend-verification-email`,
        {
          method: "POST",
        },
      );
      const json = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      if (res.ok) {
        setVerificationBannerMsg("Verification email sent — check your inbox");
        setVerificationBannerType("success");
      } else {
        setVerificationBannerMsg(
          typeof json.error === "string"
            ? json.error
            : "Failed to resend verification email",
        );
        setVerificationBannerType("error");
      }
    } catch {
      setVerificationBannerMsg("Connection error — please try again");
      setVerificationBannerType("error");
    } finally {
      setResendingVerification(false);
    }
  }
  if (loading)
    return (
      <AppShell>
        <div className="flex h-[60vh] items-center justify-center">
          <div className="h-12 w-12 animate-spin rounded-full border-4 border-mint border-t-transparent" />
        </div>
      </AppShell>
    );

  if (error || !data)
    return (
      <AppShell>
        <div className="flex h-[60vh] flex-col items-center justify-center gap-4">
          <div className="rounded-full bg-red-500/10 p-4 text-red-500">
            <Info size={48} />
          </div>
          <h2 className="text-2xl font-bold text-white">
            Analytics Unavailable
          </h2>
          <p className="text-steel">
            We couldn&apos;t load the metrics for this campaign.
          </p>
        </div>
      </AppShell>
    );

  return (
    <ErrorBoundary>
      <AppShell>
        <div className="mx-auto max-w-7xl space-y-8">
          <Link
            href={`/profile/${username}`}
            className="text-sm text-indigo-500 hover:underline"
          >
            ← Back to profile
          </Link>

          <header className="flex flex-col gap-2">
            <h1 className="text-3xl font-bold tracking-tight text-white">
              Campaign <span className="text-mint">Analytics</span>
            </h1>
            <p className="text-steel">
              Real-time performance metrics for{" "}
              <span className="text-white font-mono">{username}</span>
            </p>
          </header>

          {/* Email verification banner — owner only */}
          {isOwner && settings && (
            <>
              {settings.email && settings.emailVerified === false && (
                <div className="rounded-2xl border border-yellow-500/30 bg-yellow-500/10 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-3">
                    <span className="text-xl leading-none mt-0.5">⚠️</span>
                    <div>
                      <p className="text-sm font-semibold text-white">
                        Your email{" "}
                        <span className="font-mono text-yellow-300">
                          {settings.email}
                        </span>{" "}
                        is not verified.
                      </p>
                      {verificationBannerMsg && (
                        <p
                          className={`mt-1 text-xs ${verificationBannerType === "success" ? "text-mint" : "text-red-400"}`}
                        >
                          {verificationBannerMsg}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resendingVerification}
                    className="inline-flex min-h-[36px] items-center justify-center rounded-xl border border-yellow-500/40 bg-yellow-500/10 px-4 py-1.5 text-xs font-bold text-yellow-300 transition hover:bg-yellow-500/20 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {resendingVerification ? (
                      <span className="flex items-center gap-2">
                        <span className="h-3 w-3 animate-spin rounded-full border border-yellow-300 border-t-transparent" />
                        Sending…
                      </span>
                    ) : (
                      "Resend verification email"
                    )}
                  </button>
                </div>
              )}

              {!settings.email && (
                <div className="rounded-2xl border border-white/10 bg-white/5 p-4 flex items-center gap-3">
                  <span className="text-xl leading-none">📧</span>
                  <p className="text-sm text-sky/70">
                    Add an email to receive support notifications.{" "}
                    <Link
                      href="/create"
                      className="text-mint hover:underline font-medium"
                    >
                      Edit profile
                    </Link>
                  </p>
                </div>
              )}
            </>
          )}

          {/* Summary Cards */}
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {/* #820: use dominant asset code instead of hardcoding XLM */}
            <StatCard
              title="Total Raised"
              value={`${data.summary.totalRaised.toLocaleString()} ${getDominantAssetCode(assetBreakdown)}`}
              icon={<Wallet className="text-mint" />}
              trend={trends.totalRaised}
              positive={trends.totalRaisedPositive}
            />
            <StatCard
              title="Contributors"
              value={data.summary.totalContributors.toString()}
              icon={<Users className="text-sky" />}
              trend={trends.txCount}
              positive={trends.txCountPositive}
            />
            <StatCard
              title="Avg. Support"
              value={`${data.summary.avgContribution.toLocaleString()} ${getDominantAssetCode(assetBreakdown)}`}
              icon={<TrendingUp className="text-gold" />}
              trend="—"
              positive={true}
            />
            <StatCard
              title="Active Drips"
              value={data.summary.activeDrips.toString()}
              icon={<Activity className="text-purple-400" />}
              trend="—"
              positive={true}
            />
          </div>

          <div className="grid grid-cols-1 gap-8 lg:grid-cols-3">
            {/* Trend Chart */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="col-span-1 rounded-3xl border border-white/10 bg-white/5 p-6 lg:col-span-2 shadow-sm shadow-black/40"
            >
              <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-widest text-steel">
                  Earnings Trend
                </h3>
                <div className="inline-flex rounded-full border border-white/10 bg-white/5 p-1">
                  {(["7D", "30D", "90D"] as const).map((period) => (
                    <button
                      key={period}
                      type="button"
                      onClick={() => setSelectedPeriod(period)}
                      className={`min-h-[44px] rounded-full px-4 py-2 text-xs font-semibold transition ${
                        selectedPeriod === period
                          ? "bg-mint text-ink"
                          : "text-sky/70 hover:text-white"
                      }`}
                    >
                      {period}
                    </button>
                  ))}
                </div>
              </div>
              <div className="h-[350px] w-full">
                {chartLoading ? (
                  <div className="grid h-full gap-4">
                    <div className="h-8 w-32 animate-pulse rounded-full bg-white/10" />
                    <div className="flex-1 animate-pulse rounded-3xl bg-white/[0.04]" />
                    <div className="grid grid-cols-4 gap-3">
                      {Array.from({ length: 4 }, (_, index) => (
                        <div
                          key={index}
                          className="h-4 animate-pulse rounded-full bg-white/10"
                        />
                      ))}
                    </div>
                  </div>
                ) : isChartEmpty ? (
                  <div className="flex h-full flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[0.02] text-center">
                    <p className="text-lg font-semibold text-white">
                      No earnings data yet
                    </p>
                    <p className="mt-2 max-w-sm text-sm text-steel">
                      Earnings will appear here once successful support
                      transactions are recorded for this period.
                    </p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient
                          id="colorAmt"
                          x1="0"
                          y1="0"
                          x2="0"
                          y2="1"
                        >
                          <stop
                            offset="5%"
                            stopColor="#00FFC2"
                            stopOpacity={0.3}
                          />
                          <stop
                            offset="95%"
                            stopColor="#00FFC2"
                            stopOpacity={0}
                          />
                        </linearGradient>
                      </defs>
                      <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                      <XAxis
                        dataKey="date"
                        stroke="#ffffff40"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                      />
                      <YAxis
                        stroke="#ffffff40"
                        fontSize={12}
                        tickLine={false}
                        axisLine={false}
                        tickFormatter={(v) => `${v}`}
                      />
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#0A0A0B",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "12px",
                          fontSize: "12px",
                        }}
                        itemStyle={{ color: "#00FFC2" }}
                      />
                      <Area
                        type="monotone"
                        dataKey="amount"
                        stroke="#00FFC2"
                        fillOpacity={1}
                        fill="url(#colorAmt)"
                        strokeWidth={3}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </motion.div>

            {/* Asset Breakdown Chart */}
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-sm shadow-black/40"
            >
              <h3 className="mb-6 text-sm font-semibold uppercase tracking-widest text-steel">
                Asset Distribution
              </h3>
              <div className="h-[280px] w-full">
                {assetBreakdown.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center rounded-3xl border border-dashed border-white/10 bg-white/[0.02] text-center">
                    <p className="text-lg font-semibold text-white">
                      No earnings data yet
                    </p>
                    <p className="mt-2 max-w-sm text-sm text-steel">
                      Asset breakdown will appear once you receive support.
                    </p>
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={assetBreakdown}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={5}
                        dataKey="amount"
                        nameKey="assetCode"
                        label={(props) => {
                          const entry = props as unknown as AssetAmount;
                          return entry.assetCode;
                        }}
                        labelLine={false}
                      >
                        {assetBreakdown.map((_entry, index) => (
                          <Cell
                            key={`cell-${index}`}
                            fill={COLORS[index % COLORS.length]}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{
                          backgroundColor: "#0A0A0B",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: "12px",
                        }}
                        formatter={(value, name) => [
                          `${value} ${name}`,
                          "Amount",
                        ]}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
              {assetBreakdown.length > 0 && (
                <div className="mt-4 border-t border-white/10 pt-4 text-center space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-steel mb-2">
                    Total Earned
                  </p>
                  {assetBreakdown.map((a) => (
                    <p key={a.assetCode} className="text-xl font-bold text-white tabular-nums">
                      {a.amount.toLocaleString(undefined, {
                        maximumFractionDigits: 7,
                      })}{" "}
                      {a.assetCode}
                    </p>
                  ))}
                </div>
              )}
            </motion.div>
          </div>

          {/* Recent Transactions */}
          <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold uppercase tracking-widest text-steel font-mono">
                On-Chain Explorer Integration
              </h3>
              {isOwner && (
                <button
                  type="button"
                  onClick={handleDownloadCsv}
                  disabled={csvLoading}
                  className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-mint/30 bg-mint/10 px-4 py-2 text-xs font-bold text-mint transition hover:bg-mint/20 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {csvLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="h-3 w-3 animate-spin rounded-full border border-mint border-t-transparent" />
                      Exporting...
                    </span>
                  ) : (
                    "Download CSV"
                  )}
                </button>
              )}
            </div>
            <div className="overflow-x-auto -mx-6 px-6">
              <table className="w-full min-w-[480px] text-left text-sm text-sky/70">
                <thead className="border-b border-white/10 text-[10px] uppercase tracking-widest text-steel">
                  <tr>
                    <th className="pb-4 pr-4">Type</th>
                    <th className="pb-4 pr-4">Supporter</th>
                    <th className="pb-4 pr-4">Asset</th>
                    <th className="pb-4 pr-4">Amount</th>
                    <th className="pb-4 pr-4 text-right">Age</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {data.recentTransactions.map((item) => (
                    <tr
                      key={item.id}
                      className="group hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="py-4 pr-4">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                            item.type === "Drip"
                              ? "bg-purple-500/10 text-purple-400"
                              : "bg-mint/10 text-mint"
                          }`}
                        >
                          {item.type}
                        </span>
                      </td>
                      <td className="py-4 pr-4 font-mono text-xs max-w-[120px] truncate">
                        {item.user}
                      </td>
                      <td className="py-4 pr-4 text-white font-medium">
                        {item.asset}
                      </td>
                      <td className="py-4 pr-4 text-white font-medium">
                        {item.amount}
                      </td>
                      <td className="py-4 pr-4 text-right tabular-nums">
                        {item.age}
                      </td>
                    </tr>
                  ))}
                  {data.recentTransactions.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-8 text-center text-steel">
                        No recent transactions yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {isOwner && settings && (
            <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-widest text-steel font-mono">
                Settings
              </h3>
              {settings.email ? (
                <label className="flex items-center justify-between gap-4 rounded-2xl border border-white/10 bg-white/[0.02] px-4 py-3">
                  <span className="text-sm text-sky/80">
                    Email me when I receive a new support transaction
                  </span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={Boolean(settings.notifyOnSupport)}
                    onClick={() =>
                      handleNotificationToggle(!settings.notifyOnSupport)
                    }
                    disabled={settingsSaving}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                      settings.notifyOnSupport ? "bg-mint" : "bg-white/20"
                    } ${settingsSaving ? "opacity-60 cursor-not-allowed" : ""}`}
                  >
                    <span
                      className={`inline-block h-5 w-5 transform rounded-full bg-black transition ${
                        settings.notifyOnSupport
                          ? "translate-x-5"
                          : "translate-x-1"
                      }`}
                    />
                  </button>
                </label>
              ) : (
                <p className="text-sm text-sky/70">
                  Add an email to your profile to enable notifications.{" "}
                  <Link href="/create" className="text-mint hover:underline">
                    Edit profile
                  </Link>
                </p>
              )}
            </section>
          )}
          {/* Recurring Drips — owner only */}
          {isOwner && (
          <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
            <div className="mb-6 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-widest text-steel font-mono">
                Active Drips
              </h3>
              {drips.length > 0 && (
                <span className="rounded-full bg-purple-500/10 px-3 py-1 text-xs font-bold text-purple-400">
                  {drips.length} active
                </span>
              )}
            </div>

            {dripsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }, (_, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4"
                  >
                    <div className="h-4 w-24 animate-pulse rounded bg-white/10" />
                    <div className="h-4 w-16 animate-pulse rounded bg-white/10" />
                    <div className="h-4 w-20 animate-pulse rounded bg-white/10" />
                    <div className="ml-auto h-8 w-20 animate-pulse rounded-xl bg-white/10" />
                  </div>
                ))}
              </div>
            ) : drips.length === 0 ? (
              <p className="py-8 text-center text-sm text-steel">
                No active drips set up for this profile.
              </p>
            ) : (
              <div className="space-y-3">
                {drips.map((drip) => (
                  <div
                    key={drip.id}
                    className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.02] p-4"
                  >
                    <span className="min-w-0 flex-1 font-mono text-xs text-sky/80">
                      {drip.supporterAddress
                        ? `${drip.supporterAddress.slice(0, 6)}...${drip.supporterAddress.slice(-4)}`
                        : "Unknown"}
                    </span>
                    <span className="text-sm font-bold text-white">
                      {parseFloat(drip.amount).toLocaleString()}{" "}
                      {drip.assetCode}
                    </span>
                    <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[10px] font-semibold uppercase text-sky/70">
                      {drip.frequency}
                    </span>
                    <span className="text-xs text-sky/60">
                      Next: {new Date(drip.nextRunAt).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
          )}
        </div>
      </AppShell>
    </ErrorBoundary>
  );
}

function StatCard({
  title,
  value,
  icon,
  trend,
  positive,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  trend: string;
  positive: boolean;
}) {
  return (
    <motion.div
      whileHover={{ scale: 1.02 }}
      className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-xl shadow-black/20"
    >
      <div className="flex items-center justify-between">
        <div className="rounded-2xl bg-white/5 p-3">{icon}</div>
        <div
          className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-tight ${
            trend === "—" || trend === "No change"
              ? "text-steel"
              : positive
                ? "text-mint"
                : "text-red-400"
          }`}
        >
          {trend !== "—" &&
            trend !== "No change" &&
            (positive ? (
              <ArrowUpRight size={14} />
            ) : (
              <ArrowDownRight size={14} />
            ))}
          {trend}
        </div>
      </div>
      <div className="mt-5">
        <p className="text-[10px] uppercase tracking-[0.2em] text-steel">
          {title}
        </p>
        <h4 className="mt-1 text-2xl font-bold text-white tabular-nums">
          {value}
        </h4>
      </div>
    </motion.div>
  );
}
