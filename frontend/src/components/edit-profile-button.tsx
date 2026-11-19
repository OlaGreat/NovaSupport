"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getStoredWalletAddress } from "@/lib/wallet-adapters";

export function EditProfileButton({
  username,
  walletAddress,
}: {
  username: string;
  walletAddress: string;
}) {
  const [isOwner, setIsOwner] = useState(false);

  // Re-evaluate ownership whenever the connected wallet changes so a mid-session
  // connect/disconnect updates the UI without a reload (#1449). WalletConnect
  // dispatches wallet-connected / wallet-disconnected in this tab; `storage`
  // covers changes made from other tabs.
  useEffect(() => {
    function syncOwnership() {
      const storedAddress = getStoredWalletAddress();
      setIsOwner(Boolean(storedAddress && storedAddress === walletAddress));
    }

    function handleStorage(event: StorageEvent) {
      if (event.key === null || event.key === "walletAddress") {
        syncOwnership();
      }
    }

    syncOwnership();
    window.addEventListener("wallet-connected", syncOwnership);
    window.addEventListener("wallet-disconnected", syncOwnership);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("wallet-connected", syncOwnership);
      window.removeEventListener("wallet-disconnected", syncOwnership);
      window.removeEventListener("storage", handleStorage);
    };
  }, [walletAddress]);

  if (!isOwner) return null;

  return (
    <Link
      href={`/profile/${username}/edit`}
      className="inline-flex min-h-[36px] items-center gap-1.5 rounded-xl border border-mint/30 bg-mint/10 px-4 py-1.5 text-sm font-semibold text-mint hover:bg-mint/20 transition-colors"
    >
      Edit profile
    </Link>
  );
}
