"use client";

import { useState, useCallback } from "react";
import { Rss, Check } from "lucide-react";
import { API_BASE_URL } from "@/lib/config";

type RSSFeedButtonProps = {
  username: string;
};

export function RSSFeedButton({ username }: RSSFeedButtonProps) {
  const [showToast, setShowToast] = useState(false);

  const feedUrl = `${API_BASE_URL}/v1/profiles/${username}/feed.xml`;

  const handleClick = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(feedUrl);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = feedUrl;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2000);
  }, [feedUrl]);

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={handleClick}
        aria-label="Copy RSS feed URL"
        className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-sky/80 transition hover:bg-white/10 hover:text-white"
      >
        <Rss size={14} />
        RSS Feed
      </button>

      {showToast && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="absolute left-1/2 top-full z-50 mt-2 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/10 bg-[#0A0A0B] px-3 py-2 shadow-2xl sm:left-0 sm:translate-x-0"
        >
          <div className="flex items-center gap-1.5 text-xs text-mint">
            <Check size={12} />
            RSS feed URL copied
          </div>
        </div>
      )}
    </div>
  );
}
