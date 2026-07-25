import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { EmbedWidget, type EmbedTheme, type EmbedSize } from "@/components/embed-widget";
import { API_BASE_URL, SITE_URL } from "@/lib/config";

type PageProps = {
  params: { username: string };
  searchParams: { theme?: string; size?: string };
};

type Profile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  avatarUrl?: string | null;
  walletAddress: string;
  acceptedAssets: Array<{ code: string; issuer?: string | null }>;
};

type ProfileStats = {
  totalTransactions: number;
  uniqueSupporters: number;
  assetTotals: Array<{ assetCode: string; total: string }>;
};

type LeaderboardEntry = {
  rank: number;
  supporterAddress: string;
  totalAmount: string;
  assetCode: string;
};

async function getProfile(username: string): Promise<Profile | null> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}`, {
    next: { revalidate: 30 },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getStats(username: string): Promise<ProfileStats | null> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/stats`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getLeaderboard(username: string): Promise<LeaderboardEntry[]> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}/leaderboard`, {
    next: { revalidate: 60 },
  });
  if (!res.ok) return [];
  const body = await res.json() as { leaderboard?: LeaderboardEntry[] };
  return (body.leaderboard ?? []).slice(0, 5);
}

export async function generateMetadata({ params }: { params: { username: string } }): Promise<Metadata> {
  const profile = await getProfile(params.username);
  if (!profile) return { title: "NovaSupport Embed" };
  return {
    title: `Support ${profile.displayName} — NovaSupport`,
    robots: { index: false, follow: false },
    viewport: "width=device-width, initial-scale=1",
  };
}

export default async function EmbedPage({ params, searchParams }: PageProps) {
  const profile = await getProfile(params.username);
  if (!profile) notFound();

  const [stats, leaderboard] = await Promise.all([
    getStats(params.username),
    getLeaderboard(params.username),
  ]);

  const theme: EmbedTheme =
    searchParams.theme === "light" ? "light" : "dark";
  const size: EmbedSize =
    searchParams.size === "small"
      ? "small"
      : searchParams.size === "large"
        ? "large"
        : "medium";

  const profileUrl = `${SITE_URL}/profile/${profile.username}`;

  const recentSupporters = leaderboard.map((e) => ({
    supporterAddress: e.supporterAddress,
    totalAmount: e.totalAmount,
    assetCode: e.assetCode,
  }));

  return (
    <div
      style={{
        margin: 0,
        padding: 8,
        background: "transparent",
        fontFamily: "system-ui, -apple-system, sans-serif",
      }}
    >
      <link rel="stylesheet" href="/embed.css" />
      <EmbedWidget
        username={profile.username}
        displayName={profile.displayName}
        bio={profile.bio}
        avatarUrl={profile.avatarUrl}
        acceptedAssets={profile.acceptedAssets}
        stats={stats}
        recentSupporters={recentSupporters}
        theme={theme}
        size={size}
        profileUrl={profileUrl}
      />
    </div>
  );
}
