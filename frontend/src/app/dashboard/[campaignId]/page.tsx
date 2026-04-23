"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { AppShell } from "@/components/app-shell";
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from "recharts";
import { 
  TrendingUp, Users, Wallet, Activity, 
  ArrowUpRight, ArrowDownRight, Info
} from "lucide-react";
import { motion } from "framer-motion";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

interface AnalyticsData {
  summary: {
    totalRaised: number;
    totalContributors: number;
    avgContribution: number;
    activeDrips: number;
  };
  dailyContributions: { date: string; amount: number }[];
  assetBreakdown: { name: string; value: number }[];
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
  notifyOnSupport?: boolean;
};

type TransactionCsvRow = {
  createdAt: string;
  amount: string;
  assetCode: string;
  supporterAddress: string;
  message: string;
  status: string;
  txHash: string;
};

const COLORS = ["#00FFC2", "#00E0FF", "#FFB800", "#FF4D4D", "#9D4EDD"];

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

function normalizeAnalyticsResponse(json: unknown): AnalyticsData {
  const payload = (json ?? {}) as Record<string, unknown>;
  const summary = (payload.summary ?? {}) as Record<string, unknown>;

  const dailySource = (payload.dailyContributions ?? payload.daily_contributions ?? []) as unknown[];
  const assetSource = (payload.assetBreakdown ?? payload.asset_breakdown ?? []) as unknown[];
  const txSource = (payload.recentTransactions ?? payload.recent_transactions ?? payload.transactions ?? []) as unknown[];

  return {
    summary: {
      totalRaised: toNumber(summary.totalRaised ?? summary.total_raised ?? payload.totalRaised ?? payload.total_raised),
      totalContributors: toNumber(
        summary.totalContributors ?? summary.total_contributors ?? payload.totalContributors ?? payload.total_contributors
      ),
      avgContribution: toNumber(
        summary.avgContribution ?? summary.avg_contribution ?? payload.avgContribution ?? payload.avg_contribution
      ),
      activeDrips: toNumber(summary.activeDrips ?? summary.active_drips ?? payload.activeDrips ?? payload.active_drips),
    },
    dailyContributions: dailySource.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      return {
        date: toString(item.date, `Day ${index + 1}`),
        amount: toNumber(item.amount ?? item.totalAmount ?? item.total_amount),
      };
    }),
    assetBreakdown: assetSource.map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        name: toString(item.name ?? item.assetCode ?? item.asset_code, "Unknown"),
        value: toNumber(item.value ?? item.amount ?? item.totalAmount ?? item.total_amount),
      };
    }),
    recentTransactions: txSource.map((entry, index) => {
      const item = entry as Record<string, unknown>;
      const txType = toString(item.type ?? item.supportType ?? item.support_type, "One-time");
      const supporter = toString(
        item.user ?? item.supporter ?? item.supporterAddress ?? item.supporter_address,
        "Unknown"
      );
      const amountValue = toNumber(item.amount ?? item.totalAmount ?? item.total_amount);
      const createdAt = toString(item.createdAt ?? item.created_at, "");
      return {
        id: toString(item.id ?? item.txHash ?? item.tx_hash, `tx-${index}`),
        type: txType,
        user: supporter,
        asset: toString(item.asset ?? item.assetCode ?? item.asset_code, "XLM"),
        amount: amountValue.toString(),
        age: timeAgo(createdAt),
      };
    }),
  };
}

function csvEscape(value: string): string {
  const escaped = value.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

function downloadCsv(rows: TransactionCsvRow[]): void {
  const headers = [
    "Date",
    "Amount",
    "Asset",
    "From Address",
    "Message",
    "Status",
    "TX Hash",
    "Stellar Expert URL",
  ];
  const lines = rows.map((row) => {
    const stellarExpertUrl = `https://stellar.expert/explorer/testnet/tx/${row.txHash}`;
    return [
      new Date(row.createdAt).toISOString(),
      row.amount,
      row.assetCode,
      row.supporterAddress,
      row.message,
      row.status,
      row.txHash,
      stellarExpertUrl,
    ].map(csvEscape).join(",");
  });

  const csv = `${headers.join(",")}\n${lines.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "novasupport-transactions.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export default function DashboardPage() {
  const { campaignId } = useParams();
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [settings, setSettings] = useState<ProfileSettings | null>(null);
  const [connectedWallet, setConnectedWallet] = useState("");
  const [csvLoading, setCsvLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        const [analyticsRes, profileRes] = await Promise.all([
          fetch(`${API_BASE_URL}/analytics/${campaignId}`),
          fetch(`${API_BASE_URL}/profiles/${campaignId}`),
        ]);
        if (!analyticsRes.ok) throw new Error("Failed to fetch analytics");
        if (!profileRes.ok) throw new Error("Failed to fetch profile settings");

        const json = await analyticsRes.json();
        const profileJson = (await profileRes.json()) as Record<string, unknown>;
        setData(normalizeAnalyticsResponse(json));
        setSettings({
          walletAddress: toString(profileJson.walletAddress),
          email: toString(profileJson.email, "") || null,
          notifyOnSupport: toBool(profileJson.notifyOnSupport, true),
        });
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    }
    fetchData();
  }, [campaignId]);

  useEffect(() => {
    const wallet = window.localStorage.getItem("walletAddress");
    if (wallet) setConnectedWallet(wallet);
  }, []);

  const isOwner = Boolean(
    settings?.walletAddress &&
    connectedWallet &&
    settings.walletAddress === connectedWallet
  );

  async function handleDownloadCsv() {
    if (!isOwner) return;
    setCsvLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/profiles/${campaignId}/transactions?limit=1000`);
      if (!res.ok) throw new Error("Failed to fetch full transactions");
      const json = (await res.json()) as { transactions?: Array<Record<string, unknown>> };
      const rows: TransactionCsvRow[] = (json.transactions ?? []).map((tx) => ({
        createdAt: toString(tx.createdAt, new Date().toISOString()),
        amount: toString(tx.amount, "0"),
        assetCode: toString(tx.assetCode, "XLM"),
        supporterAddress: toString(tx.supporterAddress, ""),
        message: toString(tx.message, ""),
        status: toString(tx.status, ""),
        txHash: toString(tx.txHash, ""),
      }));
      downloadCsv(rows);
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
      const res = await fetch(`${API_BASE_URL}/profiles/${campaignId}`, {
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

  if (loading) return (
    <AppShell>
      <div className="flex h-[60vh] items-center justify-center">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-mint border-t-transparent" />
      </div>
    </AppShell>
  );

  if (error || !data) return (
    <AppShell>
      <div className="flex h-[60vh] flex-col items-center justify-center gap-4">
        <div className="rounded-full bg-red-500/10 p-4 text-red-500">
          <Info size={48} />
        </div>
        <h2 className="text-2xl font-bold text-white">Analytics Unavailable</h2>
        <p className="text-steel">We couldn&apos;t load the metrics for this campaign.</p>
      </div>
    </AppShell>
  );

  return (
    <AppShell>
      <div className="mx-auto max-w-7xl space-y-8">
        <Link href={`/profile/${campaignId}`} className="text-sm text-indigo-500 hover:underline">
          ← Back to profile
        </Link>
        
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Campaign <span className="text-mint">Analytics</span>
          </h1>
          <p className="text-steel">
            Real-time performance metrics for <span className="text-white font-mono">{campaignId}</span>
          </p>
        </header>

        {/* Summary Cards */}
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard 
            title="Total Raised" 
            value={`${data.summary.totalRaised.toLocaleString()} XLM`}
            icon={<Wallet className="text-mint" />}
            trend="+12.5%"
            positive={true}
          />
          <StatCard 
            title="Contributors" 
            value={data.summary.totalContributors.toString()}
            icon={<Users className="text-sky" />}
            trend="+8"
            positive={true}
          />
          <StatCard 
            title="Avg. Support" 
            value={`${data.summary.avgContribution} XLM`}
            icon={<TrendingUp className="text-gold" />}
            trend="-2.4%"
            positive={false}
          />
          <StatCard 
            title="Active Drips" 
            value={data.summary.activeDrips.toString()}
            icon={<Activity className="text-purple-400" />}
            trend="Stable"
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
            <h3 className="mb-6 text-sm font-semibold uppercase tracking-widest text-steel">
              Contribution Trend (7 Days)
            </h3>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data.dailyContributions}>
                  <defs>
                    <linearGradient id="colorAmt" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#00FFC2" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#00FFC2" stopOpacity={0}/>
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
                      fontSize: "12px"
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
            </div>
          </motion.div>

          {/* Pie Chart */}
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-sm shadow-black/40"
          >
            <h3 className="mb-6 text-sm font-semibold uppercase tracking-widest text-steel">
              Asset Distribution
            </h3>
            <div className="h-[350px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.assetBreakdown}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {data.assetBreakdown.map((_entry, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: "#0A0A0B", 
                      border: "1px solid rgba(255,255,255,0.1)",
                      borderRadius: "12px"
                    }}
                  />
                  <Legend verticalAlign="bottom" height={36}/>
                </PieChart>
              </ResponsiveContainer>
            </div>
          </motion.div>
        </div>

        {/* Recent Transactions */}
        <section className="rounded-3xl border border-white/10 bg-white/5 p-6">
          <div className="mb-6 flex items-center justify-between gap-4">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-steel font-mono">
              On-Chain Explorer Integration
            </h3>
            {isOwner && (
              <button
                type="button"
                onClick={handleDownloadCsv}
                disabled={csvLoading}
                className="inline-flex items-center justify-center rounded-xl border border-mint/30 bg-mint/10 px-4 py-2 text-xs font-bold text-mint transition hover:bg-mint/20 disabled:cursor-not-allowed disabled:opacity-60"
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
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-sky/70">
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
                  <tr key={item.id} className="group hover:bg-white/[0.02] transition-colors">
                    <td className="py-4 pr-4">
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                        item.type === "Drip" ? "bg-purple-500/10 text-purple-400" : "bg-mint/10 text-mint"
                      }`}>
                        {item.type}
                      </span>
                    </td>
                    <td className="py-4 pr-4 font-mono text-xs">{item.user}</td>
                    <td className="py-4 pr-4 text-white font-medium">{item.asset}</td>
                    <td className="py-4 pr-4 text-white font-medium">{item.amount}</td>
                    <td className="py-4 pr-4 text-right tabular-nums">{item.age}</td>
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
                  onClick={() => handleNotificationToggle(!settings.notifyOnSupport)}
                  disabled={settingsSaving}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
                    settings.notifyOnSupport ? "bg-mint" : "bg-white/20"
                  } ${settingsSaving ? "opacity-60 cursor-not-allowed" : ""}`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-black transition ${
                      settings.notifyOnSupport ? "translate-x-5" : "translate-x-1"
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
      </div>
    </AppShell>
  );
}

function StatCard({ title, value, icon, trend, positive }: { 
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
        <div className="rounded-2xl bg-white/5 p-3">
          {icon}
        </div>
        <div className={`flex items-center gap-1 text-[10px] font-bold uppercase tracking-tight ${
          positive ? "text-mint" : trend === "Stable" ? "text-steel" : "text-red-400"
        }`}>
          {positive ? <ArrowUpRight size={14} /> : trend === "Stable" ? null : <ArrowDownRight size={14} />}
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
