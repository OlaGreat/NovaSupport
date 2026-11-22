import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { API_BASE_URL } from "@/lib/config";
import { formatAmount } from "@/lib/format";
import { stellarExpertUrl } from "@/lib/stellar";
import { StrKey } from "@stellar/stellar-sdk";
import {
  AlertCircle,
  ArrowUpRight,
  ExternalLink,
  Share2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { Metadata } from "next";

type PageProps = {
  params: {
    address: string;
  };
};

function truncateTitle(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const short = truncateTitle(params.address);
  return {
    title: `${short} — Giving history on NovaSupport`,
    description: `See all the Stellar creators this wallet has supported on NovaSupport.`,
    openGraph: {
      title: `${short} on NovaSupport`,
      description: `Giving history for Stellar wallet ${short}`,
      url: `https://novasupport.xyz/supporters/${params.address}`,
    },
    twitter: {
      card: "summary",
      title: `${short} on NovaSupport`,
      description: `Giving history for Stellar wallet ${short}`,
    },
  };
}

type AssetTotal = {
  assetCode: string;
  total: string;
};

type SupportedProfile = {
  username: string;
  displayName: string;
  totalTransactions: number;
};

type SupportTransaction = {
  id: string;
  profileUsername: string;
  profileDisplayName: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
  txHash: string;
  createdAt: string;
  message?: string | null;
};

type SupporterData = {
  address: string;
  totalTransactions: number;
  profilesSupported: number;
  totalByAsset: AssetTotal[] | Record<string, number | string>;
  supportedProfiles?: SupportedProfile[];
  transactions?: SupportTransaction[];
  recentTransactions?: SupportTransaction[];
};

function emptySupporterData(address: string): SupporterData {
  return {
    address,
    totalTransactions: 0,
    profilesSupported: 0,
    totalByAsset: [],
    supportedProfiles: [],
    transactions: [],
  };
}

async function getSupporterData(address: string): Promise<SupporterData | null> {
  const res = await fetch(`${API_BASE_URL}/supporters/${address}`, {
    next: { revalidate: 60 },
  });

  if (res.status === 400) {
    notFound();
  }

  // A valid address with no support history is not an error — render the
  // friendly zero-transaction empty state instead of "Supporter unavailable".
  if (res.status === 404) {
    return emptySupporterData(address);
  }

  if (!res.ok) {
    return null;
  }

  return res.json();
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function normalizeAssetTotals(
  totals: SupporterData["totalByAsset"],
): AssetTotal[] {
  if (totals == null) {
    return [];
  }

  if (Array.isArray(totals)) {
    return totals;
  }

  return Object.entries(totals).map(([assetCode, total]) => ({
    assetCode,
    total: String(total),
  }));
}

export default async function SupporterPage({ params }: PageProps) {
  const { address } = params;

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return (
      <AppShell>
        <div className="mx-auto max-w-4xl">
          <div className="flex h-[60vh] flex-col items-center justify-center gap-4 text-center">
            <div className="rounded-full bg-red-500/10 p-4 text-red-400">
              <AlertCircle size={48} />
            </div>
            <h1 className="text-2xl font-bold text-white">Invalid Address</h1>
            <p className="max-w-md text-sm text-steel">
              The wallet address provided is not a valid Stellar public key.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  const data = await getSupporterData(address);

  if (!data) {
    return (
      <AppShell>
        <div className="mx-auto max-w-4xl">
          <EmptyState
            variant="no-results"
            title="Supporter unavailable"
            description="Support history could not be loaded right now."
          />
        </div>
      </AppShell>
    );
  }

  const assetTotals = normalizeAssetTotals(data.totalByAsset);
  const transactions = data.transactions ?? data.recentTransactions ?? [];
  const supportedProfiles =
    data.supportedProfiles ??
    (data.transactions
      ? Array.from(
          data.transactions
            .reduce((profiles, tx) => {
              const existing = profiles.get(tx.profileUsername);
              profiles.set(tx.profileUsername, {
                username: tx.profileUsername,
                displayName: tx.profileDisplayName,
                totalTransactions: (existing?.totalTransactions ?? 0) + 1,
              });
              return profiles;
            }, new Map<string, SupportedProfile>())
            .values(),
        )
      : []);
  const shareUrl = `/supporters/${address}`;
  const shareHref = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
    `View this NovaSupport supporter profile: ${shareUrl}`,
  )}`;

  return (
    <AppShell>
      <div className="mx-auto max-w-5xl space-y-8">
        <header className="space-y-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-mint/20 bg-mint/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-mint">
                <Wallet size={14} />
                Supporter Profile
              </div>
              <h1 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
                {truncateAddress(address)}
              </h1>
              <p className="max-w-3xl break-all font-mono text-xs leading-6 text-sky/70 sm:text-sm">
                {address}
              </p>
            </div>
            <a
              href={shareHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 text-sm font-semibold text-white transition hover:border-mint/40 hover:bg-mint/10"
            >
              <Share2 size={16} />
              Share
            </a>
          </div>
        </header>

        <section className="grid gap-4 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-wider text-sky/60">
              Transactions
            </p>
            <p className="mt-2 text-3xl font-bold text-white">
              {data.totalTransactions}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-wider text-sky/60">
              Profiles Supported
            </p>
            <p className="mt-2 text-3xl font-bold text-white">
              {data.profilesSupported}
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
            <p className="text-xs uppercase tracking-wider text-sky/60">
              Assets Used
            </p>
            <p className="mt-2 text-3xl font-bold text-white">
              {assetTotals.length}
            </p>
          </div>
        </section>

        {data.totalTransactions === 0 ? (
          <EmptyState
            variant="no-transactions"
            title="No transactions yet."
            description="This wallet has not supported any creator profiles yet."
            ctaLabel="Explore Creators"
            ctaHref="/explore"
          />
        ) : (
          <>
            <section className="grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-sky/70">
                  Total Supported by Asset
                </h2>
                <div className="mt-5 space-y-3">
                  {assetTotals.map((asset) => (
                    <div
                      key={asset.assetCode}
                      className="flex items-center justify-between gap-4 rounded-xl bg-white/[0.04] px-4 py-3"
                    >
                      <span className="text-sm font-semibold text-white">
                        {asset.assetCode}
                      </span>
                      <span className="text-right font-mono text-sm text-mint">
                        {formatAmount(asset.total)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <h2 className="text-sm font-semibold uppercase tracking-wider text-sky/70">
                  Profiles Supported
                </h2>
                <div className="mt-5 divide-y divide-white/10">
                  {supportedProfiles.map((profile) => (
                    <Link
                      key={profile.username}
                      href={`/profile/${profile.username}`}
                      className="flex items-center justify-between gap-4 py-3 transition hover:text-mint"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-white">
                          {profile.displayName}
                        </span>
                        <span className="block truncate text-xs text-sky/60">
                          @{profile.username}
                        </span>
                      </span>
                      <span className="inline-flex shrink-0 items-center gap-2 text-xs text-sky/70">
                        {profile.totalTransactions} tx
                        <ArrowUpRight size={14} />
                      </span>
                    </Link>
                  ))}
                </div>
              </div>
            </section>

            <section className="space-y-4">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-sky/70">
                Support Transaction History
              </h2>
              <div className="space-y-3">
                {transactions.map((tx) => (
                  <article
                    key={tx.id ?? tx.txHash}
                    className="rounded-2xl border border-white/10 bg-white/5 p-4"
                  >
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <Link
                          href={`/profile/${tx.profileUsername}`}
                          className="font-semibold text-mint transition hover:text-mint/80"
                        >
                          {tx.profileDisplayName}
                        </Link>
                        <p className="mt-1 text-xs text-sky/60">
                          @{tx.profileUsername}
                        </p>
                        {tx.message ? (
                          <p className="mt-3 text-sm text-sky/80">
                            {tx.message}
                          </p>
                        ) : null}
                      </div>
                      <div className="shrink-0 text-left sm:text-right">
                        <p className="text-base font-bold text-white">
                          {formatAmount(tx.amount)} {tx.assetCode}
                        </p>
                        <p className="mt-1 text-xs text-sky/60">
                          {new Date(tx.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                    <div className="mt-4 flex items-center gap-2 overflow-hidden rounded-xl bg-black/20 px-3 py-2">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-sky/60">
                        {tx.txHash}
                      </code>
                      <a
                        href={stellarExpertUrl("tx", tx.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="shrink-0 text-sky transition hover:text-white"
                        title="View on Stellar Expert"
                      >
                        <ExternalLink size={15} />
                      </a>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </div>
    </AppShell>
  );
}
