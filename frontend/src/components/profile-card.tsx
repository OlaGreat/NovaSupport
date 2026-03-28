"use client";
import { isValidStellarAddress } from "@/lib/stellar";
import { useState } from 'react';

type Asset = {
  code: string;
  issuer?: string;
};

type ProfileCardProps = {
  username: string;
  displayName: string;
  bio: string;
  walletAddress: string;
  acceptedAssets: Asset[];
};

export function ProfileCard({
  username,
  displayName,
  bio,
  walletAddress,
  acceptedAssets
}: ProfileCardProps) {
  const isValid = isValidStellarAddress(walletAddress);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(
      `${window.location.origin}/profile/${username}`
    );
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };


  return (
    <article className="rounded-[2rem] border border-white/10 bg-white/[0.04] p-7 shadow-xl shadow-black/15">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-mint">@{username}</p>
          <h1 className="mt-3 text-3xl font-semibold text-white">{displayName}</h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-sky/80">{bio}</p>
        </div>
        <div className="rounded-3xl border border-mint/20 bg-ink/50 px-4 py-3 text-sm text-sky/80">
          <p className="font-semibold text-white">Stellar Wallet</p>
          <p className="mt-2 break-all">{walletAddress}</p>
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
              {asset.issuer ? <span className="ml-2 text-xs">{asset.issuer}</span> : <span className="ml-2 text-xs">native</span>}
            </div>
          ))}
          <button onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy profile link'}
          </button>
        </div>
      </div>
    </article>
    
    
  );
  
}

