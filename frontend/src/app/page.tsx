import Link from "next/link";
import Image from "next/image";
import { AppShell } from "@/components/app-shell";
import { ProfileCard } from "@/components/profile-card";
import { API_BASE_URL } from "@/lib/config";

// ── Types ──────────────────────────────────────────────────────────────
type Asset = { code: string; issuer?: string | null };

type Profile = {
  id: string;
  username: string;
  displayName: string;
  bio: string;
  walletAddress: string;
  acceptedAssets: Asset[];
  avatarUrl?: string;
  websiteUrl?: string;
  twitterHandle?: string;
  githubHandle?: string;
  emailVerified?: boolean;
};

// ── Data fetching (server component) ──────────────────────────────────
async function getFeaturedProfiles(): Promise<Profile[]> {
  try {
    const res = await fetch(
      `${API_BASE_URL}/v1/profiles?limit=3&sort=most_supported`,
      { next: { revalidate: 300 } },
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.profiles ?? [];
  } catch {
    return [];
  }
}

// ── Page ───────────────────────────────────────────────────────────────
export default async function HomePage() {
  const featuredProfiles = await getFeaturedProfiles();

  return (
    <AppShell>
      {/* Hero */}
      <section className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-8 shadow-xl shadow-black/20 text-center sm:text-left">
        <p className="text-xs uppercase tracking-[0.35em] text-mint">
          Stellar-native creator support
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl sm:text-5xl font-semibold tracking-tight text-white">
          Support the builders of Stellar
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-8 text-sky/80">
          NovaSupport lets you send XLM or USDC directly to creators on-chain —
          no middlemen, no fees beyond the Stellar network.
        </p>
        <div className="mt-8 flex flex-wrap justify-center sm:justify-start gap-3">
          <Link
            href="/create"
            className="rounded-full bg-mint px-6 py-3 text-sm font-semibold text-ink hover:opacity-90 transition-opacity"
          >
            Create your profile
          </Link>
          <Link
            href="/explore"
            className="rounded-full border border-white/15 px-6 py-3 text-sm font-semibold text-white hover:bg-white/5 transition-colors"
          >
            Explore creators
          </Link>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-[0.35em] text-sky/60">
          How it works
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            {
              step: "1",
              title: "Connect your Freighter wallet",
              description:
                "Sign in with your Stellar wallet in one click — no email or password needed.",
            },
            {
              step: "2",
              title: "Find a creator and choose an amount",
              description:
                "Browse profiles, pick XLM or USDC, and set the amount you want to send.",
            },
            {
              step: "3",
              title: "Send directly on-chain",
              description:
                "Your payment goes straight to the creator's wallet on Stellar Testnet — no middleman.",
            },
          ].map(({ step, title, description }) => (
            <div
              key={step}
              className="rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-6"
            >
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-mint/10 text-sm font-bold text-mint">
                {step}
              </span>
              <p className="mt-4 font-semibold text-white">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-sky/70">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Feature highlights */}
      <section className="mt-10">
        <h2 className="text-xs uppercase tracking-[0.35em] text-sky/60">
          Features
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          {[
            {
              icon: "⛓️",
              title: "On-chain payments",
              description:
                "Every transaction is recorded on Stellar Testnet — fully transparent and verifiable.",
            },
            {
              icon: "🎯",
              title: "Creator milestones",
              description:
                "Set funding goals and let your community track progress toward each milestone.",
            },
            {
              icon: "🏆",
              title: "Supporter leaderboard",
              description:
                "Top supporters are highlighted on every profile, with full transaction history.",
            },
          ].map(({ icon, title, description }) => (
            <div
              key={title}
              className="rounded-[1.5rem] border border-white/10 bg-ocean/60 p-6"
            >
              <span className="text-2xl">{icon}</span>
              <p className="mt-4 font-semibold text-white">{title}</p>
              <p className="mt-2 text-sm leading-relaxed text-sky/70">
                {description}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Example profiles */}
      {featuredProfiles.length > 0 && (
        <section className="mt-10">
          <div className="flex items-center justify-between">
            <h2 className="text-xs uppercase tracking-[0.35em] text-sky/60">
              Featured creators
            </h2>
            <Link
              href="/explore"
              className="text-sm text-mint hover:underline"
            >
              See all creators →
            </Link>
          </div>
          <div className="mt-4 grid gap-6 sm:grid-cols-3">
            {featuredProfiles.map((profile) => (
              <Link
                key={profile.id}
                href={`/profile/${profile.username}`}
                className="block rounded-[1.5rem] border border-white/10 bg-white/[0.04] p-5 hover:bg-white/[0.07] transition-colors"
              >
                <div className="flex items-center gap-3">
                  {profile.avatarUrl ? (
                    <Image
                      src={profile.avatarUrl}
                      alt={profile.displayName}
                      width={40}
                      height={40}
                      className="h-10 w-10 rounded-full object-cover"
                    />
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-indigo-600 text-sm font-bold text-white">
                      {(profile.displayName?.slice(0, 2) || "?").toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="text-xs uppercase tracking-wider text-mint">
                      @{profile.username}
                    </p>
                    <p className="font-semibold text-white">
                      {profile.displayName}
                    </p>
                  </div>
                </div>
                {profile.bio && (
                  <p className="mt-3 text-sm leading-relaxed text-sky/70 line-clamp-2">
                    {profile.bio}
                  </p>
                )}
                {profile.acceptedAssets.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {profile.acceptedAssets.map((asset) => (
                      <span
                        key={`${asset.code}-${asset.issuer ?? "native"}`}
                        className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-sky/80"
                      >
                        {asset.code}
                      </span>
                    ))}
                  </div>
                )}
              </Link>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}

// Closes #562
