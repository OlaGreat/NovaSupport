"use client";
import { useState, useEffect, useCallback, KeyboardEvent } from "react";
import Image from "next/image";
import { isValidStellarAddress, stellarExpertUrl } from "@/lib/stellar";
import { useToast } from "@/lib/use-toast";
import { API_BASE_URL, SITE_URL } from "@/lib/config";
import { apiFetch } from "@/lib/api-client";
import { getStoredWalletAddress } from "@/lib/wallet-adapters";

import { ProfileCardSkeleton } from "./skeleton";

type Asset = {
  code: string;
  issuer?: string | null;
};

type ProfileStats = {
  totalTransactions: number;
  uniqueSupporters: number;
  assetTotals: Array<{ assetCode: string; total: string }>;
};

type ProfileCardProps = {
  username: string;
  displayName: string;
  bio: string;
  walletAddress: string;
  acceptedAssets: Asset[];
  avatarUrl?: string;
  email?: string;
  websiteUrl?: string;
  twitterHandle?: string;
  githubHandle?: string;
  stats?: ProfileStats;
  isLoading?: boolean;
};

export function ProfileCard({
  username,
  displayName,
  bio,
  walletAddress,
  acceptedAssets,
  avatarUrl,
  email,
  websiteUrl,
  twitterHandle,
  githubHandle,
  stats,
  isVerified,
  isLoading,
}: ProfileCardProps & { isVerified?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);
  const [isOwner, setIsOwner] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    const storedAddress = getStoredWalletAddress();
    setIsOwner(Boolean(storedAddress && storedAddress === walletAddress));
  }, [walletAddress]);

  const isValid = isValidStellarAddress(walletAddress);
  const hasSocialLinks = email || websiteUrl || twitterHandle || githubHandle;

  const handleResend = async () => {
    setResending(true);
    try {
      const res = await apiFetch(`${API_BASE_URL}/profiles/${username}/resend-verification-email`, {
        method: "POST",
      });
      const data = await res.json();
      if (res.ok) {
        setResendSent(true);
        showToast("Verification email sent! Check your inbox.", "success");
      } else {
        showToast(data.error || "Failed to resend email", "error");
      }
    } catch (err) {
      showToast("Connection error", "error");
    } finally {
      setResending(false);
    }
  };

  const handleCopy = useCallback(async () => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(walletAddress);
      } else {
        const textArea = document.createElement("textarea");
        textArea.value = walletAddress;
        textArea.style.position = "fixed";
        textArea.style.left = "-9999px";
        textArea.style.top = "0";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (!successful) throw new Error("Fallback copy failed");
      }
      showToast("Wallet address copied!", "success");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed", err);
      showToast("Failed to copy address", "error");
    }
  }, [walletAddress, showToast]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "c") {
      e.preventDefault();
      handleCopy();
    }
  };

  const profileUrl = typeof window !== 'undefined' 
    ? `${window.location.origin}/profile/${username}`
    : `${SITE_URL}/profile/${username}`;

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(profileUrl);
      setLinkCopied(true);
      showToast("Profile link copied!", "success");
      setTimeout(() => setLinkCopied(false), 2000);
    } catch (err) {
      showToast("Failed to copy profile link", "error");
    }
  }, [profileUrl, showToast]);

  const tweetText = encodeURIComponent(`Support me on NovaSupport: ${profileUrl}`);
  const tweetUrl = `https://twitter.com/intent/tweet?text=${tweetText}`;

  const expertUrl = stellarExpertUrl("account", walletAddress);

  if (isLoading) return <ProfileCardSkeleton />;

  return (
    <div className="space-y-4">
      {isOwner && !isVerified && (
        <div className="rounded-2xl border border-gold/30 bg-gold/5 p-4 flex items-center justify-between gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
          {resendSent ? (
            <div className="flex items-center gap-3 w-full">
              <span className="text-xl">📬</span>
              <div>
                <p className="text-sm font-semibold text-white">Check your email</p>
                <p className="text-xs text-sky/70">We sent a new verification link to your inbox. It expires in 24 hours.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className="text-xl">✉️</span>
                <div>
                  <p className="text-sm font-semibold text-white">Verify your email address</p>
                  <p className="text-xs text-sky/70">Check your inbox to secure your profile and receive notifications.</p>
                </div>
              </div>
              <button
                onClick={handleResend}
                disabled={resending}
                className="text-xs font-bold text-gold hover:text-white transition-colors disabled:opacity-50"
              >
                {resending ? 'Sending...' : 'Resend link'}
              </button>
            </>
          )}
        </div>
      )}

      <article className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-5 sm:p-7 shadow-xl shadow-black/15">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex gap-4">
            {avatarUrl ? (
              <Image
                src={avatarUrl}
                alt={displayName}
                width={64}
                height={64}
                className="w-16 h-16 rounded-full object-cover"
              />
            ) : (
              <div className="w-16 h-16 rounded-full bg-indigo-600 flex items-center justify-center text-white text-xl font-bold">
                {(displayName?.slice(0, 2) || '?').toUpperCase()}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <p className="text-xs uppercase tracking-[0.3em] text-mint">@{username}</p>
                {isVerified && (
                  <span title="Verified Creator" className="flex items-center justify-center w-4 h-4 rounded-full bg-mint text-ink text-[10px] font-bold">
                    ✓
                  </span>
                )}
              </div>
              <h1 className="mt-3 text-2xl sm:text-3xl font-semibold text-white flex items-center gap-3">
                {displayName}
              </h1>
              <p className="mt-4 max-w-2xl text-sm sm:text-base leading-relaxed sm:leading-7 text-sky/80">{bio}</p>

            {stats && (
              <div className="mt-6 flex flex-wrap gap-8 items-center border-t border-white/5 pt-6">
                <div>
                  <p className="text-xs uppercase tracking-wider text-sky/60">Total Support</p>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
                    {stats.assetTotals.length > 0 ? (
                      stats.assetTotals.map((asset) => (
                        <span key={asset.assetCode} className="text-sm font-semibold text-white">
                          {parseFloat(asset.total).toLocaleString()} {asset.assetCode}
                        </span>
                      ))
                    ) : (
                      <span className="text-sm font-semibold text-white">0 XLM</span>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-sky/60">Supporters</p>
                  {stats.uniqueSupporters === 0 ? (
                    <p className="mt-1 text-sm font-semibold text-gold">Be the first to support!</p>
                  ) : (
                    <p className="mt-1 text-sm font-semibold text-white">
                      {stats.uniqueSupporters === 1
                        ? "1 supporter"
                        : `${stats.uniqueSupporters} supporters`}
                    </p>
                  )}
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider text-sky/60">Transactions</p>
                  <p className="mt-1 text-sm font-semibold text-white">{stats.totalTransactions}</p>
                </div>
              </div>
            )}

            {/* Share Buttons */}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                onClick={handleCopyLink}
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors"
              >
                {linkCopied ? '✓ Link copied!' : '🔗 Copy link'}
              </button>
              <a
                href={tweetUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-medium text-white hover:bg-white/10 transition-colors inline-block"
              >
                𝕏 Share on X
              </a>
            </div>

            {hasSocialLinks && (
              <div className="mt-4 flex flex-wrap gap-3">
                {websiteUrl && (
                  <a
                    href={websiteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-sky/70 hover:text-mint transition"
                  >
                    🌐 Website
                  </a>
                )}
                {twitterHandle && (
                  <a
                    href={`https://twitter.com/${twitterHandle}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-sky/70 hover:text-mint transition"
                  >
                    𝕏 @{twitterHandle}
                  </a>
                )}
                {githubHandle && (
                  <a
                    href={`https://github.com/${githubHandle}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-xs text-sky/70 hover:text-mint transition"
                  >
                    GitHub
                  </a>
                )}
                {email && (
                  <span className="text-xs text-sky/50">{email}</span>
                )}
              </div>
            )}
          </div>
        </div>
        <div className="w-full sm:w-auto mt-4 sm:mt-0 rounded-3xl border border-mint/20 bg-ink/50 px-4 py-3 text-sm text-sky/80">
          <p className="font-semibold text-white">Stellar Wallet</p>
          <div className="mt-2 flex items-center">
            <a
              href={expertUrl}
              target="_blank"
              rel="noopener noreferrer"
              onKeyDown={handleKeyDown}
              aria-label={`Stellar wallet address: ${walletAddress}. Press Ctrl+C to copy.`}
              className="text-xs text-indigo-500 hover:underline font-mono break-all flex-1 focus:outline-none focus:ring-1 focus:ring-mint/50 rounded"
            >
              {walletAddress}
            </a>
            <button 
              onClick={handleCopy} 
              aria-label="Copy wallet address to clipboard"
              title="Copy to clipboard"
              className="ml-2 p-1 text-gray-400 hover:text-white transition-colors focus:outline-none focus:ring-1 focus:ring-mint/50 rounded"
            >
              {copied ? (
                <span className="text-mint flex items-center gap-1">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  Copied
                </span>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 12-2h2a2 2 0 12 2m0 0h2a2 2 0 12 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                </svg>
              )}
            </button>
          </div>
          <p className={`mt-3 ${isValid ? "text-mint" : "text-gold"}`}>
            {isValid ? "Valid Stellar address" : "Replace with a valid Stellar address"}
          </p>
        </div>
      </div>

      <div className="mt-8">
        <p className="text-sm font-semibold text-white">Accepted assets</p>
        <div className="mt-3 flex flex-wrap gap-3">
          {acceptedAssets.map((asset) => (
            <div
              key={`${asset.code}-${asset.issuer ?? "native"}`}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-sky/80"
            >
              <span className="font-semibold text-white">{asset.code}</span>
              {asset.issuer ? (
                <span className="ml-2 text-xs" title={asset.issuer}>
                  {asset.issuer.length > 10
                    ? `${asset.issuer.slice(0, 4)}…${asset.issuer.slice(-4)}`
                    : asset.issuer}
                </span>
              ) : (
                <span className="ml-2 text-xs">native</span>
              )}
            </div>
          ))}
        </div>
      </div>
    </article>
    </div>
  );
}
