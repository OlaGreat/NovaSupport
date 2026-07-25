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

type SupportTx = {
  txHash: string;
  amount: string;
  assetCode: string;
  createdAt: string;
  supporterAddress: string | null;
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

async function getRecentTransactions(username: string): Promise<SupportTx[]> {
  const res = await fetch(
    `${API_BASE_URL}/profiles/${username}/transactions?limit=5`,
    { next: { revalidate: 30 } },
  );
  if (!res.ok) return [];
  const body = await res.json() as { transactions?: SupportTx[] };
  return body.transactions ?? [];
}

export async function generateMetadata({ params }: { params: { username: string } }): Promise<Metadata> {
  const profile = await getProfile(params.username);
  if (!profile) return { title: "NovaSupport Embed" };
  return {
    title: `Support ${profile.displayName} — NovaSupport`,
    robots: { index: false, follow: false },
  };
}

export default async function EmbedPage({ params, searchParams }: PageProps) {
  const profile = await getProfile(params.username);
  if (!profile) notFound();

  const [stats, recentTransactions] = await Promise.all([
    getStats(params.username),
    getRecentTransactions(params.username),
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

  const recentSupporters = recentTransactions
    .filter((tx): tx is SupportTx & { supporterAddress: string } => Boolean(tx.supporterAddress))
    .map((tx) => ({
      supporterAddress: tx.supporterAddress,
      totalAmount: tx.amount,
      assetCode: tx.assetCode,
    }));

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <link rel="stylesheet" href="/embed.css" />
      </head>
      <body
        style={{
          margin: 0,
          padding: 8,
          background: "transparent",
          fontFamily: "system-ui, -apple-system, sans-serif",
        }}
      >
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
      </body>
    </html>
  );
}
