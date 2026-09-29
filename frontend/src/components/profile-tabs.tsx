"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  History, Award, LayoutDashboard,
  ExternalLink, Search, Calendar, X
} from "lucide-react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { EmptyState } from "./empty-state";
import { stellarExpertUrl } from "@/lib/stellar";
import { useRouter } from "next/navigation";
import { API_BASE_URL } from "@/lib/config";

type Transaction = {
  id: string;
  txHash: string;
  amount: string;
  assetCode: string;
  message?: string;
  supporterAddress?: string;
  createdAt: string;
  status: string;
  memo?: string | null;
};

type Badge = {
  id: string;
  name: string;
  description: string;
  icon: string;
  criteria: string;
  awardedAt: string;
};

// ── Date range presets ───────────────────────────────────────────────────────��[...]
type DatePreset = "all" | "7d" | "30d" | "custom";

function getPresetRange(preset: DatePreset): { from: Date | null; to: Date | null } {
  const now = new Date();
  if (preset === "7d") {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    return { from, to: now };
  }
  if (preset === "30d") {
    const from = new Date(now);
    from.setDate(from.getDate() - 30);
    return { from, to: now };
  }
  return { from: null, to: null };
}

// ── Highlight matching text ───────────────────────────────────────────────────
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-mint/30 text-white rounded px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function ProfileTabs({ username }: { username: string }) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<"history" | "badges">("history");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [badges, setBadges] = useState<Badge[]>([]);
  const [loading, setLoading] = useState(false);
  const [badgesLoading, setBadgesLoading] = useState(false);

  // ── URL hash sync ───────────────────────────────────────────────────────
  useEffect(() => {
    // Read hash on mount
    const hash = window.location.hash.slice(1); // Remove the #
    if (hash === "badges") {
      setActiveTab("badges");
    } else {
      setActiveTab("history"); // Default to history
    }

    // Listen for hash changes (back/forward navigation)
    const handleHashChange = () => {
      const newHash = window.location.hash.slice(1);
      if (newHash === "badges") {
        setActiveTab("badges");
      } else {
        setActiveTab("history");
      }
    };

    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Update URL hash when tab changes
  const handleTabChange = useCallback((tab: "history" | "badges") => {
    setActiveTab(tab);
    const newHash = tab === "badges" ? "#badges" : "#history";
    window.history.replaceState(null, "", newHash);
  }, []);

  // ── Search state (#554) ────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Date filter state (#461) ───────────────────────────────────────────────
  const [preset, setPreset] = useState<DatePreset>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const statusStyles: Record<string, string> = {
    SUCCESS: "bg-green-100 text-green-800",
    PENDING: "bg-yellow-100 text-yellow-800",
    FAILED:  "bg-red-100 text-red-800",
  };

  // Debounce search term 300ms then update debouncedSearch
  const handleSearchChange = useCallback((value: string) => {
    setSearch(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setDebouncedSearch(value);
    }, 300);
  }, []);

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  // Abort the in-flight request whenever the query changes so a slower earlier
  // response can never overwrite the results of a newer one (#1064).
  useEffect(() => {
    const controller = new AbortController();
    const isStale = () => controller.signal.aborted;

    if (activeTab === "history") {
      setLoading(true);
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      const url = `${API_BASE_URL}/profiles/${username}/transactions${params.toString() ? "?" + params.toString() : ""}`;
      fetch(url, { signal: controller.signal })
        .then(res => res.json())
        .then(data => {
          if (isStale()) return;
          setTransactions(data.transactions || []);
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.error(err);
        })
        .finally(() => {
          if (!isStale()) setLoading(false);
        });
    }
    if (activeTab === "badges") {
      setBadgesLoading(true);
      fetch(`${API_BASE_URL}/profiles/${username}/badges`, { signal: controller.signal })
        .then(res => res.json())
        .then(data => {
          if (isStale()) return;
          setBadges(data.badges || []);
        })
        .catch(err => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          console.error(err);
        })
        .finally(() => {
          if (!isStale()) setBadgesLoading(false);
        });
    }

    return () => controller.abort();
  }, [username, activeTab, debouncedSearch]);

  // ── Filtered transactions (date only; search handled by API) ──────────────
  const filtered = useMemo(() => {
    let result = transactions;

    const { from, to } = preset === "custom"
      ? {
          from: customFrom ? new Date(customFrom) : null,
          // Use the viewer's local timezone when deriving the end-of-day for the
          // custom "To" date so we include the entire selected local calendar day
          // instead of a fixed UTC instant which would cut off viewers behind UTC.
          to: customTo ? (() => {
            const [y, m, d] = customTo.split("-").map(Number);
            return new Date(y, (m || 1) - 1, d || 1, 23, 59, 59, 999);
          })() : null,
        }
      : getPresetRange(preset);

    if (from) result = result.filter(tx => new Date(tx.createdAt) >= from);
    if (to)   result = result.filter(tx => new Date(tx.createdAt) <= to);

    return result;
  }, [transactions, preset, customFrom, customTo]);

  const clearFilters = () => {
    setSearch("");
    setDebouncedSearch("");
    setPreset("all");
    setCustomFrom("");
    setCustomTo("");
  };

  const hasFilters = search || preset !== "all" || customFrom || customTo;

  return (
    <div className="space-y-6">
      {/* ── Tab header ───────────────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 border-b border-white/5 pb-1">
        <div className="flex gap-8">
          <TabButton
            active={activeTab === "history"}
            onClick={() => handleTabChange("history")}
            icon={<History size={16} />}
            label="Support History"
          />
          <TabButton
            active={activeTab === "badges"}
            onClick={() => handleTabChange("badges")}
            icon={<Award size={16} />}
            label="Badges"
          />
        </div>

        <Link
          href={`/dashboard/${username}`}
          className="w-full sm:w-auto flex items-center justify-center sm:justify-start gap-2 rounded-xl bg-mint/10 px-4 py-2 text-xs font-bold text-mint transition hover:bg-mint/20"
        >
          <LayoutDashboard size={14} />
          View Dashboard
        </Link>
      </div>

      <AnimatePresence mode="wait">
        {activeTab === "history" ? (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="min-h-[300px] space-y-4"
          >
            {/* ── Search & filter toolbar ────────────────────────────────── */}
            <div className="flex flex-col sm:flex-row gap-3">
              {/* Search input (#554) */}
              <div className="relative flex-1">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-steel" />
                <input
                  type="text"
                  value={search}
                  onChange={e => handleSearchChange(e.target.value)}
                  placeholder="Search by message…"
                  className="w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-9 py-2 text-sm text-white placeholder:text-steel focus:border-mint/40 focus:outline-none focus:ring-1 focu[...]"
                />
                {search && (
                  <button
                    onClick={() => {
                      setSearch("");
                      setDebouncedSearch("");
                    }}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-steel hover:text-white transition"
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>

              {/* Date range preset buttons (#461) */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <Calendar size={14} className="text-steel hidden sm:block" />
                {(["all", "7d", "30d", "custom"] as DatePreset[]).map(p => (
                  <button
                    key={p}
                    onClick={() => setPreset(p)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                      preset === p
                        ? "bg-mint text-midnight"
                        : "bg-white/5 text-steel hover:text-white hover:bg-white/10"
                    }`}
                  >
                    {p === "all" ? "All time" : p === "7d" ? "Last 7d" : p === "30d" ? "Last 30d" : "Custom"}
                  </button>
                ))}
              </div>
            </div>

            {/* Custom date range inputs */}
            {preset === "custom" && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex flex-col sm:flex-row gap-3"
              >
                <div className="flex-1">
                  <label className="block text-[10px] uppercase tracking-widest text-steel mb-1">From</label>
                  <input
                    type="date"
                    value={customFrom}
                    onChange={e => setCustomFrom(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white focus:border-mint/40 focus:outline-none focus:ring-1 focus:ring-mint/30 transition"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-[10px] uppercase tracking-widest text-steel mb-1">To</label>
                  <input
                    type="date"
                    value={customTo}
                    onChange={e => setCustomTo(e.target.value)}
                    className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-white focus:border-mint/40 focus:outline-none focus:ring-1 focus:ring-mint/30 transition"
                  />
                </div>
              </motion.div>
            )}

            {/* Active filter indicator */}
            {hasFilters && (
              <div className="flex items-center gap-2">
                <span className="text-xs text-steel">
                  {filtered.length} result{filtered.length !== 1 ? "s" : ""} found
                </span>
                <button
                  onClick={clearFilters}
                  className="flex items-center gap-1 text-xs text-mint hover:text-mint/80 transition"
                >
                  <X size={12} /> Clear filters
                </button>
              </div>
            )}

            {/* Transaction table */}
            {loading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-mint border-t-transparent" />
              </div>
            ) : filtered.length > 0 ? (
              <div className="overflow-x-auto rounded-2xl border border-white/10 bg-white/5">
                <table className="w-full text-left text-sm text-sky/70">
                  <thead className="bg-white/5 text-[10px] uppercase tracking-widest text-steel font-bold">
                    <tr>
                      <th className="px-6 py-4">Status</th>
                      <th className="px-6 py-4">Amount</th>
                      <th className="px-6 py-4">Supporter</th>
                      <th className="px-6 py-4">Message</th>
                      <th className="px-6 py-4">Memo</th>
                      <th className="px-6 py-4">Transaction</th>
                      <th className="px-6 py-4 text-right">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {filtered.map(tx => (
                      <tr key={tx.id} className="group hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${statusStyles[tx.status] ?? "bg-gray-100 text-gray-800"}`}>
                            {tx.status}
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className="text-white font-medium">
                            <Highlight text={`${tx.amount} ${tx.assetCode}`} query={search} />
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono text-xs">
                          {tx.supporterAddress ? (
                            <Highlight
                              text={`${tx.supporterAddress.slice(0, 4)}…${tx.supporterAddress.slice(-4)}`}
                              query={search}
                            />
                          ) : (
                            <span className="text-steel italic">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 max-w-[180px] truncate text-xs">
                          {tx.message ? (
                            <Highlight text={tx.message} query={search} />
                          ) : (
                            <span className="text-steel italic">—</span>
                          )}
                        </td>
                        <td className="px-6 py-4 max-w-[12rem]">
                          {tx.memo ? (
                            <span className="block truncate text-sky/80" title={tx.memo}>
                              {tx.memo}
                            </span>
                          ) : (
                            <span className="text-sky/30">-</span>
                          )}
                        </td>
                        <td className="px-6 py-4">
                          <a
                            href={stellarExpertUrl("tx", tx.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1 font-mono text-xs hover:text-mint transition-colors"
                          >
                            {tx.txHash.slice(0, 8)}…{tx.txHash.slice(-8)}
                            <ExternalLink size={12} />
                          </a>
                        </td>
                        <td className="px-6 py-4 text-right tabular-nums text-xs">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <>
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  {transactions.length > 0 ? (
                    debouncedSearch ? (
                      <>
                        <p className="text-gray-500 font-medium">No transactions match your search</p>
                        <p className="text-sm text-gray-400 mt-1">Try a different keyword.</p>
                      </>
                    ) : (
                      <>
                        <p className="text-gray-500 font-medium">No matching transactions</p>
                        <p className="text-sm text-gray-400 mt-1">Try adjusting your search or date filters.</p>
                      </>
                    )
                  ) : (
                    <EmptyState
                      variant="no-transactions"
                      title="No transactions yet"
                      description="Be the first to support this creator!"
                    />
                  )}
                </div>
              </>
            )}
          </motion.div>
        ) : (
          /* ── Badges tab (#460) ─────────────────────────────────────────── */
          <motion.div
            key="badges"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            className="min-h-[300px]"
          >
            {badgesLoading ? (
              <div className="flex h-40 items-center justify-center">
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-mint border-t-transparent" />
              </div>
            ) : badges.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
                {badges.map(badge => (
                  <div
                    key={badge.id}
                    className="flex flex-col items-center gap-2 rounded-2xl border border-white/10 bg-white/[0.03] p-4 text-center hover:border-mint/30 hover:bg-white/[0.06] transition"
                    title={badge.criteria}
                  >
                    <span className="text-3xl">{badge.icon}</span>
                    <p className="text-xs font-bold text-white leading-tight">{badge.name}</p>
                    <p className="text-[10px] text-steel">{badge.description}</p>
                    <p className="text-[10px] text-steel/60 mt-1">
                      Awarded {new Date(badge.awardedAt).toLocaleDateString()}
                    </p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-12 text-center text-gray-400">
                <Award size={40} className="text-steel/30 mb-4" />
                <p className="text-lg font-medium">No badges yet</p>
                <p className="text-sm mt-1">Achievement badges will appear here once earned.</p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function TabButton({ active, onClick, icon, label }: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 border-b-2 py-4 text-sm font-semibold transition-all ${
        active
          ? "border-mint text-mint"
          : "border-transparent text-steel hover:text-white"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
