"use client";

import { useState } from "react";
import { SHARE_DONE_KEY_PREFIX } from "@/components/onboarding-checklist";

type ShareButtonProps = {
  displayName: string;
  username: string;
};

export function ShareButton({ displayName, username }: ShareButtonProps) {
  const [copied, setCopied] = useState(false);

  const profileUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/profile/${username}`
      : `/profile/${username}`;

  function markShared() {
    if (typeof window !== "undefined") {
      localStorage.setItem(`${SHARE_DONE_KEY_PREFIX}${username}`, "true");
    }
  }

  const handleShare = async () => {
    if (typeof navigator !== "undefined" && navigator.share) {
      try {
        await navigator.share({
          title: `${displayName} on NovaSupport`,
          text: `Support ${displayName} on Stellar`,
          url: profileUrl,
        });
        markShared();
      } catch (err) {
        // User dismissed the share sheet — ignore AbortError silently
        if (err instanceof Error && err.name !== "AbortError") {
          // Non-abort error: fall back to clipboard
          await copyToClipboard();
        }
      }
    } else {
      // Desktop fallback: copy to clipboard
      await copyToClipboard();
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
    } catch {
      // Legacy fallback
      const textarea = document.createElement("textarea");
      textarea.value = profileUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    markShared();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label={copied ? "Profile link copied" : `Share ${displayName}'s profile`}
      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors"
    >
      {copied ? (
        <>
          <span>✓</span>
          <span>Link copied!</span>
        </>
      ) : (
        <>
          <span>↑</span>
          <span>Share</span>
        </>
      )}
    </button>
  );
}
