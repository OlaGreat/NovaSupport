import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { AppShell } from "@/components/app-shell";
import { ProfileCard } from "@/components/profile-card";
import { SupportPanel } from "@/components/support-panel";
import { ProfileTabs } from "@/components/profile-tabs";
import { QRCodeButton } from "@/components/qr-code-button";
import { RSSFeedButton } from "@/components/rss-feed-button";
import { ShareButton } from "@/components/share-button";
import { EmptyState } from "@/components/empty-state";
import { EmbedCodeGenerator } from "@/components/embed-widget";
import { MilestoneCard } from "@/components/milestone-card";
import { ActivityFeed } from "@/components/activity-feed";
import { EditProfileButton } from "@/components/edit-profile-button";
import { ReportProfileModal } from "@/components/report-profile-modal";
import { API_BASE_URL, SITE_URL } from "@/lib/config";
import { stellarExpertUrl } from "@/lib/stellar";

type PageProps = {
  params: {
    username: string;
  };
};

type Profile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  walletAddress: string;
  avatarUrl?: string | null;
  websiteUrl?: string | null;
  twitterHandle?: string | null;
  githubHandle?: string | null;
  acceptedAssets: Array<{ code: string; issuer?: string | null }>;
  emailVerified?: boolean;
};

type SupportTx = {
  txHash: string;
  amount: string;
  assetCode: string;
  message?: string | null;
  createdAt: string;
  supporterAddress: string | null;
};

type Milestone = {
  id: string;
  title: string;
  description?: string | null;
  targetAmount: string;
  currentAmount: string;
  assetCode: string;
  status: string;
  createdAt: string;
};

type Badge = {
  id: string;
  name: string;
  description: string;
  icon: string;
  awardedAt: string;
};

type LeaderboardEntry = {
  rank: number;
  supporterAddress: string;
  totalAmount: string;
  assetCode: string;
};

type ProfileStats = {
  totalTransactions: number;
  uniqueSupporters: number;
  assetTotals: Array<{ assetCode: string; total: string }>;
};

async function getProfile(username: string): Promise<Profile> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}`, {
    next: { revalidate: 10 },
  });

  if (res.status === 404) notFound();
  if (!res.ok) throw new Error("Failed to fetch profile");

  return res.json();
}

export async function generateMetadata({
  params,
}: {
  params: { username: string };
}): Promise<Metadata> {
  const res = await fetch(`${API_BASE_URL}/profiles/${params.username}`, {
    next: { revalidate: 60 },
  });

  if (!res.ok) {
    return { title: "Profile not found — NovaSupport" };
  }

  const profile: Profile = await res.json();

  return {
    title: `${profile.displayName} on NovaSupport`,
    description: profile.bio ?? `Support ${profile.displayName} on NovaSupport`,
    openGraph: {
      title: `${profile.displayName} on NovaSupport`,
      description: profile.bio ?? `Support ${profile.displayName} on NovaSupport`,
      url: `${SITE_URL}/profile/${params.username}`,
      type: "profile",
    },
    twitter: {
      card: "summary_large_image",
      title: `${profile.displayName} on NovaSupport`,
      description: profile.bio ?? `Support ${profile.displayName} on NovaSupport`,
    },
    alternates: {
      types: {
        "application/rss+xml": `${API_BASE_URL}/profiles/${params.username}/feed.xml`,
      },
    },
  };
}

async function getTransactions(username: string, limit = 10): Promise<SupportTx[]> {
  const res = await fetch(
    `${API_BASE_URL}/profiles/${username}/transactions?limit=${limit}`,
    { next: { revalidate: 60 } },
  );
  if (!res.ok) return [];
  const body = await res.json();
  return body.transactions ?? [];
}

function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 4)}...${address.slice(-4)}`;
}

async function getLeaderboard(username: string): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/leaderboard`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];

  const body = (await res.json()) as {
    leaderboard?: Array<Record<string, unknown>>;
  };

  return (body.leaderboard ?? [])
    .slice(0, 5)
    .map((entry, index) => {
      const address = String(
        entry.supporterAddress ?? entry.supporter_address ?? entry.address ?? "",
      );
      const amount = String(
        entry.totalAmount ?? entry.total_amount ?? entry.amount ?? "0",
      );
      const assetCode = String(
        entry.assetCode ?? entry.asset_code ?? entry.asset ?? "XLM",
      );
      const rankFromApi = Number(entry.rank);
      return {
        rank: Number.isFinite(rankFromApi) && rankFromApi > 0 ? rankFromApi : index + 1,
        supporterAddress: address,
        totalAmount: amount,
        assetCode,
      };
    })
    .filter((entry) => entry.supporterAddress.length > 0);
}

async function getStats(username: string): Promise<ProfileStats | null> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/stats`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getMilestones(username: string): Promise<Milestone[]> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/milestones`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  const body = await res.json();
  return body.milestones ?? body ?? [];
}

async function getBadges(username: string): Promise<Badge[]> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/badges`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  const body = await res.json();
  return body.badges ?? [];
}

export default async function ProfilePage({ params }: PageProps) {
  const [profile, transactions, leaderboard, stats, milestones, badges] =
    await Promise.all([
      getProfile(params.username),
      getTransactions(params.username, 10),
      getLeaderboard(params.username),
      getStats(params.username),
      getMilestones(params.username),
      getBadges(params.username),
    ]);

  const visibleMilestones = milestones.filter(
    (m) => m.status === "active" || m.status === "reached",
  );

  const activeMilestone = visibleMilestones.find((m) => m.status === "active");
  const milestoneProgress = activeMilestone
    ? (() => {
        const target = parseFloat(activeMilestone.targetAmount);
        const current = parseFloat(activeMilestone.currentAmount);
        return target > 0
          ? Math.min(100, Math.round((current / target) * 100))
          : null;
      })()
    : null;

  const sameAs = [
    profile.websiteUrl,
    profile.twitterHandle
      ? `https://twitter.com/${profile.twitterHandle.replace(/^@/, "")}`
      : null,
    profile.githubHandle
      ? `https://github.com/${profile.githubHandle.replace(/^@/, "")}`
      : null,
  ].filter(Boolean) as string[];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    "mainEntity": {
      "@type": "Person",
      "name": profile.displayName,
      "alternateName": profile.username,
      "description": profile.bio || undefined,
      "image": profile.avatarUrl || undefined,
      "url": `${SITE_URL}/profile/${profile.username}`,
      "identifier": profile.walletAddress,
      ...(sameAs.length > 0 ? { sameAs } : {}),
    },
  };

  return (
    <AppShell>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-8 items-start animate-fade-in">
        <div className="space-y-12">
          <div className="space-y-3">
            <ProfileCard
              username={profile.username}
              displayName={profile.displayName}
              bio={profile.bio}
              walletAddress={profile.walletAddress}
              acceptedAssets={profile.acceptedAssets}
              avatarUrl={profile.avatarUrl || undefined}
              isVerified={profile.emailVerified}
              stats={stats || undefined}
            />
            <div className="px-2 flex gap-2">
              <QRCodeButton username={profile.username} />
              <RSSFeedButton username={profile.username} />
              <ShareButton displayName={profile.displayName} username={profile.username} />
              <EditProfileButton username={profile.username} walletAddress={profile.walletAddress} />
              <ReportProfileModal username={profile.username} displayName={profile.displayName} />
            </div>
          </div>

          {badges.length > 0 && (
            <div className="px-2">
              <h3 className="text-sm font-semibold uppercase tracking-widest text-steel mb-3">
                Badges
              </h3>
              <div className="flex flex-wrap gap-2">
                {badges.slice(0, 6).map((badge) => (
                  <div
                    key={badge.id}
                    title={badge.name}
                    className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm hover:bg-white/10 transition-colors cursor-default"
                  >
                    <span>{badge.icon}</span>
                    <span className="text-xs text-steel">{badge.name}</span>
                  </div>
                ))}
                {badges.length > 6 && (
                  <div className="flex items-center rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-steel">
                    +{badges.length - 6} more
                  </div>
                )}
              </div>
            </div>
          )}

          {visibleMilestones.length > 0 && (
            <div className="px-2 space-y-4">
              <h3 className="text-sm font-semibold uppercase tracking-widest text-steel">
                Funding Goals
              </h3>
              <div className="space-y-4">
                {visibleMilestones.map((milestone, i) => (
                  <MilestoneCard key={milestone.id} milestone={milestone} index={i} />
                ))}
              </div>
            </div>
          )}

          <div className="px-2">
            <h3 className="text-sm font-semibold uppercase tracking-widest text-steel mb-4">
              Activity Feed
            </h3>
            <ActivityFeed username={profile.username} limit={8} />
          </div>

          <div className="px-2">
            <ProfileTabs username={profile.username} />
          </div>

          <div className="px-2">
            <EmbedCodeGenerator username={profile.username} />
          </div>
        </div>

        <aside className="sticky top-24">
          <SupportPanel
            walletAddress={profile.walletAddress}
            acceptedAssets={profile.acceptedAssets}
            profileId={profile.id}
            recipientDisplayName={profile.displayName}
          />

          {leaderboard.length > 0 ? (
            <div className="mt-6 rounded-3xl border border-white/5 bg-white/[0.02] p-6">
              <h4 className="text-[10px] uppercase tracking-[0.25em] text-steel font-bold mb-4">
                Top Supporters
              </h4>
              <div className="space-y-3">
                {leaderboard.map((entry) => (
                  <div
                    key={`${entry.rank}-${entry.supporterAddress}`}
                    className="flex items-center justify-between gap-4"
                  >
                    <span className="text-xs text-sky/70">#{entry.rank}</span>
                    <a
                      href={stellarExpertUrl("account", entry.supporterAddress)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-mono text-xs text-white hover:text-mint transition-colors"
                    >
                      {truncateAddress(entry.supporterAddress)}
                    </a>
                    <span className="text-xs font-semibold text-mint">
                      {entry.totalAmount} {entry.assetCode}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="mt-6">
              <EmptyState
                variant="no-supporters"
                title="Be the first to support this creator."
                description="This profile hasn't received support yet."
                ctaLabel="Support Creator"
                ctaHref={`/profile/${profile.username}`}
              />
            </div>
          )}

          <div className="mt-6 rounded-3xl border border-white/5 bg-white/[0.02] p-6">
            <h4 className="text-[10px] uppercase tracking-[0.25em] text-steel font-bold mb-4">
              Campaign Stats
            </h4>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-sky/60">Total Raised</span>
                <span className="text-sm font-bold text-white">
                  {stats?.assetTotals?.[0]?.total || "0"}{" "}
                  {stats?.assetTotals?.[0]?.assetCode || "XLM"}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-sky/60">Supporters</span>
                <span className="text-sm font-bold text-white">
                  {stats?.uniqueSupporters || 0}
                </span>
              </div>
              {milestoneProgress !== null && (
                <>
                  <div className="w-full bg-white/5 h-1.5 rounded-full overflow-hidden mt-2">
                    <div
                      className="bg-mint h-full transition-all"
                      style={{ width: `${milestoneProgress}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-steel text-center italic">
                    {milestoneProgress}% of goal reached
                  </p>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </AppShell>
  );
}
