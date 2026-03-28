import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AppShell } from "@/components/app-shell";
import { ProfileCard } from "@/components/profile-card";
import { SupportPanel } from "@/components/support-panel";
import { API_BASE_URL } from "@/lib/config";

type PageProps = {
  params: {
    username: string;
  };
};

type Profile = {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl?: string | null;
  walletAddress: string;
  acceptedAssets: Array<{ code: string; issuer?: string | null }>;
};

async function getProfile(username: string): Promise<Profile> {
  const res = await fetch(`${API_BASE_URL}/profiles/${username}`, {
    next: { revalidate: 60 }
  });

  if (res.status === 404) {
    notFound();
  }

  if (!res.ok) {
    throw new Error("Failed to fetch profile");
  }

  return res.json();
}

export async function generateMetadata({
  params
}: PageProps): Promise<Metadata> {
  const res = await fetch(`${API_BASE_URL}/profiles/${params.username}`, {
    next: { revalidate: 60 }
  });

  if (!res.ok) {
    return {
      title: "Profile not found - NovaSupport"
    };
  }

  const profile: Profile = await res.json();
  const title = `${profile.displayName} (@${profile.username}) - NovaSupport`;
  const description =
    profile.bio ?? `Support ${profile.displayName} on NovaSupport`;
  const openGraphTitle = `${profile.displayName} - NovaSupport`;
  const openGraphDescription =
    profile.bio ?? `Support ${profile.displayName} on the Stellar network`;
  const images = profile.avatarUrl ? [{ url: profile.avatarUrl }] : [];

  return {
    title,
    description,
    openGraph: {
      title: openGraphTitle,
      description: openGraphDescription,
      images,
      type: "profile"
    },
    twitter: {
      card: "summary",
      title: openGraphTitle,
      description: openGraphDescription,
      images: profile.avatarUrl ? [profile.avatarUrl] : []
    }
  };
}

export default async function ProfilePage({ params }: PageProps) {
  const profile = await getProfile(params.username);

  return (
    <AppShell>
      <div className="space-y-8">
        <ProfileCard
          username={profile.username}
          displayName={profile.displayName}
          bio={profile.bio}
          walletAddress={profile.walletAddress}
          acceptedAssets={profile.acceptedAssets}
        />
        <SupportPanel walletAddress={profile.walletAddress} />
      </div>
    </AppShell>
  );
}

