"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  TrendingUp,
  Send,
  Award,
  RefreshCw,
  ChevronDown,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { API_BASE_URL } from "@/lib/config";
import { stellarExpertUrl } from "@/lib/stellar";

type ActivityItem = {
  id: string;
  type: "support" | "milestone" | "profile_update";
  title: string;
  description: string;
  timestamp: string;
  metadata?: {
    amount?: string;
    assetCode?: string;
    supporter?: string;
    txHash?: string;
    milestone?: string;
  };
};

function getActivityIcon(type: string) {
  switch (type) {
    case "support":
      return <Send className="h-5 w-5 text-mint" />;
    case "milestone":
      return <Award className="h-5 w-5 text-yellow-400" />;
    case "profile_update":
      return <RefreshCw className="h-5 w-5 text-blue-400" />;
    default:
      return <TrendingUp className="h-5 w-5 text-white/50" />;
  }
}

function formatDate(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

function truncateHash(hash: string, length: number = 8): string {
  if (!hash) return "";
  return `${hash.substring(0, length)}...${hash.substring(hash.length - 4)}`;
}

type ActivityFeedProps = {
  username: string;
  limit?: number;
};

async function fetchActivities(username: string, signal?: AbortSignal): Promise<{
  items: ActivityItem[];
  milestonesUnavailable: boolean;
}> {
  const [transactionsRes, milestonesRes] = await Promise.all([
    fetch(`${API_BASE_URL}/profiles/${username}/transactions?limit=100`, { signal }),
    fetch(`${API_BASE_URL}/profiles/${username}/milestones`, { signal }).catch(() => null),
  ]);

  const transactionsData = transactionsRes.ok
    ? await transactionsRes.json()
    : { transactions: [] };

  let milestonesUnavailable = milestonesRes?.ok !== true;
  let milestonesData = { milestones: [] };

  if (!milestonesUnavailable) {
    try {
      milestonesData = await milestonesRes!.json();
    } catch {
      milestonesUnavailable = true;
    }
  }

  const items: ActivityItem[] = [];

  // Add transaction activities
  const transactions = transactionsData.transactions || [];
  transactions.forEach((tx: any) => {
    items.push({
      id: `tx-${tx.id}`,
      type: "support",
      title: `Received ${tx.amount} ${tx.assetCode}`,
      description: `Support from ${truncateHash(tx.supporterAddress ?? '', 8)}`,
      timestamp: tx.createdAt,
      metadata: {
        amount: tx.amount,
        assetCode: tx.assetCode,
        supporter: tx.supporterAddress,
        txHash: tx.txHash,
      },
    });
  });

  // Add milestone activities
  const milestones = milestonesData.milestones || [];
  milestones.forEach((milestone: any) => {
    if (milestone.reachedAt) {
      items.push({
        id: `milestone-${milestone.id}`,
        type: "milestone",
        title: `Milestone reached: ${milestone.title}`,
        description: `Goal of ${milestone.targetAmount} ${milestone.assetCode} achieved`,
        timestamp: milestone.reachedAt,
        metadata: {
          milestone: milestone.title,
          amount: milestone.targetAmount,
          assetCode: milestone.assetCode,
        },
      });
    }
  });

  // Sort by timestamp (newest first)
  items.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return { items, milestonesUnavailable };
}

export function ActivityFeed({ username, limit = 10 }: ActivityFeedProps) {
  const [displayedItems, setDisplayedItems] = useState(limit);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["activity-feed", username],
    queryFn: ({ signal }) => fetchActivities(username, signal),
  });

  const activities = data?.items ?? [];
  const milestonesUnavailable = data?.milestonesUnavailable ?? false;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="space-y-4 w-full max-w-md">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-20 bg-white/5 rounded-lg animate-pulse border border-white/10"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-red-500/10 border border-red-500/20 p-4 text-sm text-red-400">
        Failed to load activity feed
      </div>
    );
  }

  const visibleActivities = activities.slice(0, displayedItems);
  const remainingCount = Math.max(0, activities.length - displayedItems);

  return (
    <div className="space-y-3">
      {/* Partial-failure notice: milestones API failed but transactions loaded */}
      {milestonesUnavailable && (
        <div className="flex items-center gap-2 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-4 py-2 text-sm text-yellow-400">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span>Milestone data could not be loaded — the feed may be incomplete.</span>
          <button
            onClick={() => refetch()}
            className="ml-auto flex-shrink-0 text-xs underline underline-offset-2 hover:text-yellow-300 transition"
          >
            Retry
          </button>
        </div>
      )}

      {activities.length === 0 ? (
        <div className="text-center py-12">
          <TrendingUp className="h-12 w-12 text-white/20 mx-auto mb-4" />
          <p className="text-white/50">No activity yet</p>
        </div>
      ) : (
        <>
          <AnimatePresence>
            {visibleActivities.map((activity, index) => (
              <motion.div
                key={activity.id}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ delay: index * 0.05 }}
                className="group relative rounded-xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/10 hover:border-white/20"
              >
                <div className="flex gap-4">
                  {/* Icon */}
                  <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-white/5">
                    {getActivityIcon(activity.type)}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <h3 className="font-semibold text-white text-sm truncate">
                        {activity.title}
                      </h3>
                      <span className="flex-shrink-0 text-xs text-white/50 whitespace-nowrap">
                        {formatDate(activity.timestamp)}
                      </span>
                    </div>

                    <p className="text-xs text-white/60 mb-3">{activity.description}</p>

                    {/* Metadata */}
                    {activity.metadata && (
                      <div className="flex flex-wrap gap-2">
                        {activity.metadata.amount && (
                          <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-mint/10 text-xs text-mint font-mono">
                            {activity.metadata.amount} {activity.metadata.assetCode}
                          </span>
                        )}
                        {activity.metadata.txHash && (
                          <a
                            href={stellarExpertUrl('tx', activity.metadata.txHash)}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white/5 text-xs text-white/70 hover:text-white/90 transition font-mono"
                          >
                            {truncateHash(activity.metadata.txHash)}
                            <span>↗</span>
                          </a>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Load more button */}
          {remainingCount > 0 && (
            <motion.button
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              onClick={() => setDisplayedItems((prev) => prev + limit)}
              className="w-full mt-4 py-3 rounded-lg border border-white/10 bg-white/5 text-sm font-medium text-white transition hover:bg-white/10 hover:border-white/20 flex items-center justify-center gap-2"
            >
              Load more
              <ChevronDown size={16} />
              <span className="text-xs text-white/60">({remainingCount} more)</span>
            </motion.button>
          )}
        </>
      )}
    </div>
  );
}
