"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { apiFetch } from "@/lib/api-client";
import { API_BASE_URL } from "@/lib/config";

const DISMISSED_KEY_PREFIX = "onboardingChecklistDismissed:";
export const SHARE_DONE_KEY_PREFIX = "onboardingShareDone:";

type ChecklistItem = {
  key: string;
  label: string;
  done: boolean;
  href: string;
};

type Props = {
  username: string;
  milestoneCount: number;
};

export function OnboardingChecklist({ username, milestoneCount }: Props) {
  const [dismissed, setDismissed] = useState(true); // default hidden until we know state
  const [shareDone, setShareDone] = useState(false);
  const [profile, setProfile] = useState<{
    emailVerified: boolean;
    avatarUrl: string | null;
    bio: string;
    websiteUrl: string | null;
    twitterHandle: string | null;
    githubHandle: string | null;
  } | null>(null);

  useEffect(() => {
    const dismissedKey = `${DISMISSED_KEY_PREFIX}${username}`;
    if (localStorage.getItem(dismissedKey) === "true") {
      return; // stay dismissed, don't bother fetching
    }

    // Read the share-done flag for this user
    const shareDoneKey = `${SHARE_DONE_KEY_PREFIX}${username}`;
    setShareDone(localStorage.getItem(shareDoneKey) === "true");

    apiFetch(`${API_BASE_URL}/profiles/${username}`)
      .then(async (res) => {
        if (!res.ok) return;
        const data = await res.json();
        setProfile({
          emailVerified: Boolean(data.emailVerified),
          avatarUrl: data.avatarUrl ?? null,
          bio: data.bio ?? "",
          websiteUrl: data.websiteUrl ?? null,
          twitterHandle: data.twitterHandle ?? null,
          githubHandle: data.githubHandle ?? null,
        });
        setDismissed(false);
      })
      .catch(() => {});
  }, [username]);

  if (dismissed || !profile) return null;

  const items: ChecklistItem[] = [
    {
      key: "email",
      label: "Verify your email",
      done: profile.emailVerified,
      href: "/settings",
    },
    {
      key: "avatar",
      label: "Add an avatar",
      done: !!profile.avatarUrl,
      href: `/profile/${username}/edit`,
    },
    {
      key: "bio",
      label: "Write a bio",
      done: profile.bio.trim().length > 0,
      href: `/profile/${username}/edit`,
    },
    {
      key: "social",
      label: "Connect a social link",
      done: !!(profile.websiteUrl || profile.twitterHandle || profile.githubHandle),
      href: `/profile/${username}/edit`,
    },
    {
      key: "milestone",
      label: "Create your first milestone",
      done: milestoneCount > 0,
      href: "/dashboard",
    },
    {
      key: "share",
      label: "Share your page",
      done: shareDone,
      href: `/profile/${username}`,
    },
  ];

  const completedCount = items.filter((i) => i.done).length;
  const allComplete = completedCount === items.length;

  function handleDismiss() {
    localStorage.setItem(`${DISMISSED_KEY_PREFIX}${username}`, "true");
    setDismissed(true);
  }

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-widest text-white/60">
          Getting started
        </h2>
        <button
          onClick={handleDismiss}
          className="text-xs text-white/40 hover:text-white"
        >
          {allComplete ? "Dismiss" : "Got it"}
        </button>
      </div>

      <div>
        <div className="flex items-center justify-between text-xs text-white/50 mb-1">
          <span>
            {completedCount} of {items.length} steps complete
          </span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
          <div
            className="h-full rounded-full bg-[#00e5b0] transition-all"
            style={{ width: `${(completedCount / items.length) * 100}%` }}
          />
        </div>
      </div>

      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item.key}>
            <Link
              href={item.href}
              className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition ${
                item.done
                  ? "text-white/40"
                  : "text-white hover:bg-white/[0.04]"
              }`}
            >
              <span
                className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full border ${
                  item.done ? "border-mint bg-mint/20 text-mint" : "border-white/20"
                }`}
              >
                {item.done && <Check size={10} />}
              </span>
              <span className={item.done ? "line-through" : ""}>{item.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
