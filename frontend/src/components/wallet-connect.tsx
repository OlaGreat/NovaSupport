"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getAvailableWallets,
  getWalletAdapter,
  mapWalletError,
  type WalletAdapter,
  type WalletId,
} from "@/lib/wallet-adapters";

function truncateAddress(address: string) {
  return `${address.slice(0, 6)}...${address.slice(-6)}`;
}

const STORAGE_KEY = "walletAddress";
const STORAGE_WALLET_ID = "walletId";

type WalletConnectProps = {
  onConnect?: (address: string) => void;
};

export function WalletConnect({ onConnect }: WalletConnectProps = {}) {
  const router = useRouter();
  const [address, setAddress] = useState<string | null>(null);
  const [activeWallet, setActiveWallet] = useState<WalletId | null>(null);
  const [available, setAvailable] = useState<WalletAdapter[]>([]);
  const [status, setStatus] = useState("Choose a wallet to connect.");
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingWalletId, setConnectingWalletId] = useState<WalletId | null>(null);

  useEffect(() => {
    // Wallet extensions inject their global object asynchronously — checking
    // only once on mount races against that injection and loses on first load.
    // Strategy: re-check on window `load` (all scripts done) and after two
    // short delays (100 ms catches fast injectors, 1 000 ms catches slow ones).
    // Any signal that fires after a wallet appears will update the list without
    // requiring a manual refresh.
    function refresh() {
      setAvailable(getAvailableWallets());
    }

    refresh(); // synchronous best-effort check on mount

    const t1 = setTimeout(refresh, 100);
    const t2 = setTimeout(refresh, 1000);

    window.addEventListener("load", refresh);

    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      window.removeEventListener("load", refresh);
    };
  }, []);

  useEffect(() => {
    const savedAddress = localStorage.getItem(STORAGE_KEY);
    const savedWalletId = localStorage.getItem(STORAGE_WALLET_ID) as WalletId | null;
    if (savedAddress && savedWalletId) {
      setAddress(savedAddress);
      setActiveWallet(savedWalletId);
      const adapter = getWalletAdapter(savedWalletId);
      setStatus(`${adapter?.name ?? savedWalletId} connected`);
      onConnect?.(savedAddress);
    }
  }, [onConnect]);

  const connectWallet = useCallback(async (walletId: WalletId) => {
    const adapter = getWalletAdapter(walletId);
    if (!adapter) return;

    setConnecting(true);
    setConnectingWalletId(walletId);
    setError(null);
    setStatus(`Connecting to ${adapter.name}...`);

    try {
      const pubkey = await adapter.connect();
      localStorage.setItem(STORAGE_KEY, pubkey);
      localStorage.setItem(STORAGE_WALLET_ID, walletId);
      window.dispatchEvent(new Event("wallet-connected"));
      setAddress(pubkey);
      setActiveWallet(walletId);
      setStatus(`${adapter.name} connected`);
      onConnect?.(pubkey);

      const redirectPath = localStorage.getItem("redirectAfterLogin");
      if (redirectPath) {
        localStorage.removeItem("redirectAfterLogin");
        router.replace(redirectPath);
      }
    } catch (err) {
      const msg = err instanceof Error ? mapWalletError(err) : `Failed to connect ${adapter.name}.`;
      setError(msg);
      setStatus("Connection failed.");
    } finally {
      setConnecting(false);
      setConnectingWalletId(null);
    }
  }, [onConnect]);

  function disconnectWallet() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(STORAGE_WALLET_ID);
    window.dispatchEvent(new Event("wallet-disconnected"));
    setAddress(null);
    setActiveWallet(null);
    setError(null);
    setStatus("Choose a wallet to connect.");
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-white/5 p-5 shadow-2xl shadow-black/20 backdrop-blur">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-mint">Wallet</p>
          <div className="mt-2 text-sm text-sky/80">
            {error ? <p className="text-red-400">{error}</p> : <p>{status}</p>}
          </div>
        </div>
        {address && (
          <button
            type="button"
            onClick={disconnectWallet}
            className="rounded-full bg-mint px-4 py-2 text-sm font-semibold text-ink transition hover:bg-white"
          >
            Disconnect
          </button>
        )}
      </div>

      {/* Wallet selector — shown when not connected */}
      {!address && (
        <div className="mt-4 flex flex-col gap-2">
          {available.length === 0 ? (
            <p className="text-sm text-sky/60">
              No Stellar wallets detected.{" "}
              <a
                href="https://freighter.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-mint underline decoration-mint/30 underline-offset-4 hover:decoration-mint"
              >
                Install Freighter
              </a>
              ,{" "}
              <a
                href="https://albedo.link"
                target="_blank"
                rel="noopener noreferrer"
                className="text-mint underline decoration-mint/30 underline-offset-4 hover:decoration-mint"
              >
                Albedo
              </a>
              , or{" "}
              <a
                href="https://lobstr.co"
                target="_blank"
                rel="noopener noreferrer"
                className="text-mint underline decoration-mint/30 underline-offset-4 hover:decoration-mint"
              >
                Lobstr
              </a>
            </p>
          ) : (
            available.map((wallet) => (
              <button
                key={wallet.id}
                type="button"
                disabled={connecting}
                onClick={() => connectWallet(wallet.id)}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4 text-left transition hover:border-mint/50 hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <span className="text-xl">{wallet.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-white">{wallet.name}</p>
                  <p className="text-xs text-sky/60">Click to connect</p>
                </div>
                {connectingWalletId === wallet.id && (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-mint border-t-transparent" />
                )}
              </button>
            ))
          )}
        </div>
      )}

      {address && (
        <div className="mt-4 flex items-center gap-3 rounded-2xl border border-mint/30 bg-ink/50 p-3 text-sm text-white">
          {activeWallet && (
            <span className="text-lg">{getWalletAdapter(activeWallet)?.icon}</span>
          )}
          <span>
            Connected:{" "}
            <span className="font-semibold">{truncateAddress(address)}</span>
          </span>
        </div>
      )}
    </div>
  );
}
