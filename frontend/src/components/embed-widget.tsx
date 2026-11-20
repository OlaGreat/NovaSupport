"use client";

import { useState } from "react";
import { SITE_URL } from "@/lib/config";

type Asset = {
  code: string;
  issuer?: string | null;
};

type ProfileStats = {
  totalTransactions: number;
  uniqueSupporters: number;
  assetTotals?: Array<{ assetCode: string; total: string }>;
};

type Supporter = {
  supporterAddress: string;
  totalAmount: string;
  assetCode: string;
};

export type EmbedTheme = "dark" | "light";
export type EmbedSize = "small" | "medium" | "large";

type EmbedWidgetProps = {
  username: string;
  displayName: string;
  bio: string;
  avatarUrl?: string | null;
  acceptedAssets: Asset[];
  stats?: ProfileStats | null;
  recentSupporters?: Supporter[];
  theme?: EmbedTheme;
  size?: EmbedSize;
  profileUrl: string;
};

const sizeClasses: Record<EmbedSize, string> = {
  small: "max-w-xs text-xs",
  medium: "max-w-sm text-sm",
  large: "max-w-md text-sm",
};

const themeClasses: Record<EmbedTheme, { bg: string; border: string; text: string; muted: string; accent: string; btn: string }> = {
  dark: {
    bg: "bg-[#0a0a0f]",
    border: "border-white/10",
    text: "text-white",
    muted: "text-white/50",
    accent: "text-[#00e5b0]",
    btn: "bg-[#00e5b0] text-[#0a0a0f] hover:bg-[#00c99a]",
  },
  light: {
    bg: "bg-white",
    border: "border-gray-200",
    text: "text-gray-900",
    muted: "text-gray-500",
    accent: "text-indigo-600",
    btn: "bg-indigo-600 text-white hover:bg-indigo-700",
  },
};

export function EmbedWidget({
  username,
  displayName,
  bio,
  avatarUrl,
  acceptedAssets,
  stats,
  recentSupporters = [],
  theme = "dark",
  size = "medium",
  profileUrl,
}: EmbedWidgetProps) {
  const t = themeClasses[theme];
  const s = sizeClasses[size];
  const [failedAvatarUrl, setFailedAvatarUrl] = useState<string | null>(null);

  const truncate = (addr: string) =>
    addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;

  return (
    <div
      className={`${s} ${t.bg} border ${t.border} rounded-2xl p-4 font-sans shadow-xl w-full`}
      data-theme={theme}
      data-size={size}
    >
      {/* Header */}
      <div className="flex items-center gap-3 mb-3">
        {avatarUrl && failedAvatarUrl !== avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="w-10 h-10 rounded-full object-cover flex-shrink-0"
            onError={() => setFailedAvatarUrl(avatarUrl)}
          />
        ) : (
          <div className="w-10 h-10 rounded-full bg-indigo-600 flex items-center justify-center text-white font-bold flex-shrink-0">
            {(displayName ? displayName.slice(0, 2) : "?").toUpperCase()}
          </div>
        )}
        <div className="min-w-0">
          <p className={`font-semibold truncate ${t.text}`}>{displayName}</p>
          <p className={`${t.muted} truncate`}>@{username}</p>
        </div>
      </div>

      {/* Bio */}
      {bio && (
        <p className={`${t.muted} mb-3 line-clamp-2 leading-relaxed`}>{bio}</p>
      )}

      {/* Stats */}
      {stats && (
        <div className={`flex gap-4 mb-3 pb-3 border-b ${t.border}`}>
          <div>
            <p className={`${t.muted} uppercase tracking-wider`} style={{ fontSize: "0.6rem" }}>
              Supporters
            </p>
            <p className={`font-bold ${t.text}`}>{stats.uniqueSupporters}</p>
          </div>
          <div>
            <p className={`${t.muted} uppercase tracking-wider`} style={{ fontSize: "0.6rem" }}>
              Transactions
            </p>
            <p className={`font-bold ${t.text}`}>{stats.totalTransactions}</p>
          </div>
          {stats.assetTotals?.slice(0, 1).map((a) => (
            <div key={a.assetCode}>
              <p className={`${t.muted} uppercase tracking-wider`} style={{ fontSize: "0.6rem" }}>
                Total ({a.assetCode})
              </p>
              <p className={`font-bold ${t.accent}`}>
                {parseFloat(a.total).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Recent supporters */}
      {recentSupporters.length > 0 && (
        <div className="mb-3">
          <p className={`${t.muted} uppercase tracking-wider mb-1`} style={{ fontSize: "0.6rem" }}>
            Recent Supporters
          </p>
          <div className="space-y-1">
            {recentSupporters.slice(0, 3).map((s) => (
              <div key={s.supporterAddress} className="flex items-center justify-between">
                <span className={`font-mono ${t.muted}`}>{truncate(s.supporterAddress)}</span>
                <span className={`font-semibold ${t.accent}`}>
                  {s.totalAmount} {s.assetCode}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Accepted assets */}
      {acceptedAssets.length > 0 && (
        <div className={`flex flex-wrap gap-1 mb-3 pb-3 border-b ${t.border}`}>
          {acceptedAssets.map((a) => (
            <span
              key={`${a.code}-${a.issuer ?? "native"}`}
              className={`rounded-full border ${t.border} px-2 py-0.5 ${t.muted}`}
              style={{ fontSize: "0.65rem" }}
            >
              {a.code}
            </span>
          ))}
        </div>
      )}

      {/* CTA */}
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={`block w-full text-center rounded-xl px-3 py-2 font-semibold transition-colors ${t.btn}`}
      >
        Support {displayName}
      </a>

      {/* Powered by */}
      <p className={`text-center mt-2 ${t.muted}`} style={{ fontSize: "0.6rem" }}>
        Powered by{" "}
        <a
          href={SITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={t.accent}
        >
          NovaSupport
        </a>
      </p>
    </div>
  );
}

type EmbedCodeGeneratorProps = {
  username: string;
};

export function EmbedCodeGenerator({ username }: EmbedCodeGeneratorProps) {
  const [theme, setTheme] = useState<EmbedTheme>("dark");
  const [size, setSize] = useState<EmbedSize>("medium");
  const [copied, setCopied] = useState(false);

  const baseUrl =
    typeof window !== "undefined"
      ? window.location.origin
      : SITE_URL;

  const iframeUrl = `${baseUrl}/embed/${username}?theme=${theme}&size=${size}`;
  const embedCode = `<iframe
  src="${iframeUrl}"
  width="${size === "small" ? 320 : size === "medium" ? 380 : 448}"
  height="600"
  frameborder="0"
  style="border:none;border-radius:1rem;"
  title="Support ${username} on NovaSupport"
></iframe>`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(embedCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback for older browsers
      const ta = document.createElement("textarea");
      ta.value = embedCode;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-6 space-y-4">
      <h3 className="text-sm font-semibold text-white uppercase tracking-widest">
        Embed on Your Website
      </h3>

      <div className="flex flex-wrap gap-4">
        <div>
          <label className="text-xs text-sky/60 uppercase tracking-wider block mb-1">
            Theme
          </label>
          <div className="flex gap-2">
            {(["dark", "light"] as EmbedTheme[]).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  theme === t
                    ? "border-mint text-mint bg-mint/10"
                    : "border-white/10 text-sky/60 hover:border-white/30"
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="text-xs text-sky/60 uppercase tracking-wider block mb-1">
            Size
          </label>
          <div className="flex gap-2">
            {(["small", "medium", "large"] as EmbedSize[]).map((s) => (
              <button
                key={s}
                onClick={() => setSize(s)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  size === s
                    ? "border-mint text-mint bg-mint/10"
                    : "border-white/10 text-sky/60 hover:border-white/30"
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative">
        <pre className="rounded-xl border border-white/10 bg-black/40 p-4 text-xs text-sky/80 overflow-x-auto whitespace-pre-wrap break-all">
          {embedCode}
        </pre>
        <button
          onClick={handleCopy}
          aria-label={copied ? "Embed code copied" : "Copy embed code"}
          className="absolute top-2 right-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1 text-xs font-medium text-white hover:bg-white/10 transition-colors"
        >
          {copied ? "Copied!" : "Copy"}
        </button>
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {copied ? "Embed code copied to clipboard" : ""}
        </div>
      </div>
    </div>
  );
}
