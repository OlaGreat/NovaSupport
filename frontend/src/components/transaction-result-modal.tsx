"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import FocusTrap from "focus-trap-react";
import { stellarConfig, withStellarRetry, stellarExpertUrl } from "@/lib/stellar";

type TransactionResultModalProps = {
  txHash: string | null;
  amount: string;
  assetCode: string;
  recipientDisplayName: string;
  note?: string | null;
  isOpen: boolean;
  onClose: () => void;
};

export function TransactionResultModal({
  txHash,
  amount,
  assetCode,
  recipientDisplayName,
  note,
  isOpen,
  onClose,
}: TransactionResultModalProps) {
  const [copied, setCopied] = useState(false);
  const [txStatus, setTxStatus] = useState<
    "confirming" | "confirmed" | "finalized" | "failed"
  >("confirming");
  const [txStatusMessage, setTxStatusMessage] = useState<string | null>(null);
  const finalizeTimeoutRef = useRef<number | null>(null);
  const pollingDoneRef = useRef(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      window.addEventListener("keydown", handleEscape);
    }
    return () => window.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  const explorerUrl = useMemo(() => {
    if (!txHash) return null;
    return stellarExpertUrl("tx", txHash);
  }, [txHash]);

  useEffect(() => {
    if (!isOpen || !txHash) return;

    setTxStatus("confirming");
    setTxStatusMessage(null);
    pollingDoneRef.current = false;

    const startedAt = Date.now();
    const intervalMs = 2_000;
    const maxDurationMs = 30_000;
    let cancelled = false;

    async function checkOnce() {
      try {
        const result = await withStellarRetry(async () => {
          const res = await fetch(
            `${stellarConfig.horizonUrl.replace(/\/$/, "")}/transactions/${txHash}`,
            { cache: "no-store" },
          );

          if (res.status === 404) return { kind: "pending" } as const;
          if (!res.ok) throw new Error(`Horizon tx lookup failed: ${res.status}`);

          const json = (await res.json()) as { successful?: boolean };
          return {
            kind: "found",
            successful: Boolean(json.successful),
          } as const;
        });

        if (cancelled) return;
        if (result.kind === "pending") return;
        if (!result.successful) {
          setTxStatus("failed");
          setTxStatusMessage("Transaction failed on-chain.");
          pollingDoneRef.current = true;
          return;
        }

        setTxStatus("confirmed");
        pollingDoneRef.current = true;
        if (finalizeTimeoutRef.current) {
          window.clearTimeout(finalizeTimeoutRef.current);
        }
        finalizeTimeoutRef.current = window.setTimeout(() => {
          setTxStatus("finalized");
        }, 1500);
      } catch (err) {
        if (cancelled || pollingDoneRef.current) return;
        setTxStatus("failed");
        setTxStatusMessage("Couldn't confirm transaction. Please check the explorer.");
        pollingDoneRef.current = true;
        console.error("Transaction status polling failed", err);
      }
    }

    void checkOnce();
    const interval = window.setInterval(() => {
      if (Date.now() - startedAt > maxDurationMs) {
        window.clearInterval(interval);
        if (!pollingDoneRef.current) {
          setTxStatus("failed");
          setTxStatusMessage("Could not confirm in time. Check the explorer for status.");
        }
        return;
      }
      if (pollingDoneRef.current) {
        window.clearInterval(interval);
        return;
      }
      void checkOnce();
    }, intervalMs);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      if (finalizeTimeoutRef.current) {
        window.clearTimeout(finalizeTimeoutRef.current);
        finalizeTimeoutRef.current = null;
      }
    };
  }, [isOpen, txHash]);

  if (!isOpen || !txHash) return null;

  const safeExplorerUrl =
    explorerUrl ?? stellarExpertUrl("tx", txHash);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(safeExplorerUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
    }
  };

  const truncateHash = (hash: string) => {
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  };

  return (
    <FocusTrap
      focusTrapOptions={{
        escapeDeactivates: false, // We handle Escape via the keydown listener above
        allowOutsideClick: true,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="transaction-modal-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-ink/80 backdrop-blur-sm"
          onClick={onClose}
        />

        {/* Modal Content */}
        <div className="relative w-full max-w-md overflow-hidden rounded-[2.5rem] border border-white/10 bg-gradient-to-br from-gold/20 via-ink to-ink p-8 shadow-2xl">
          <div className="flex flex-col items-center text-center">
            {/* Success Icon */}
            <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-mint/10 text-mint">
              <svg
                className="h-10 w-10 animate-bounce"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>

            <h3 id="transaction-modal-title" className="mb-2 text-2xl font-bold text-white">Support Sent!</h3>
            <p className="mb-8 text-sky/80">
              You successfully sent <span className="font-bold text-white">{amount} {assetCode}</span> to <span className="font-bold text-white">{recipientDisplayName}</span>.
            </p>

            {note ? (
              <div className="mb-5 w-full rounded-2xl border border-mint/20 bg-mint/10 px-4 py-3 text-sm text-mint">
                {note}
              </div>
            ) : null}

            {/* Transaction Info */}
            <div className="mb-8 w-full rounded-2xl border border-white/5 bg-white/5 p-4">
              <p className="mb-1 text-[10px] uppercase tracking-[0.2em] text-sky/50">Transaction Hash</p>
              <p className="font-mono text-sm text-mint">{truncateHash(txHash)}</p>

              <div className="mt-3 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs text-sky/80">
                <span className="font-semibold text-white">Status:</span>{" "}
                <span
                  aria-live={txStatus === "failed" ? "assertive" : "polite"}
                  aria-atomic="true"
                >
                  {txStatus === "confirming" && "Confirming..."}
                  {txStatus === "confirmed" && "Confirmed ✓"}
                  {txStatus === "finalized" && "Finalized"}
                  {txStatus === "failed" && "Failed"}
                  {txStatusMessage ? (
                    <span className="mt-1 block text-red-300">{txStatusMessage}</span>
                  ) : null}
                </span>
              </div>

              <div className="mt-4 flex gap-2">
                <a
                  href={safeExplorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 rounded-xl bg-white/5 px-4 py-2 text-xs font-semibold text-white transition hover:bg-white/10"
                >
                  View on Explorer
                </a>
                <button
                  onClick={handleCopy}
                  aria-label="Copy Stellar Expert transaction link"
                  className="flex-1 rounded-xl bg-mint px-4 py-2 text-xs font-semibold text-ink transition hover:bg-white"
                >
                  {copied ? "Copied!" : "Copy Link"}
                </button>
              </div>
            </div>

            <button
              onClick={onClose}
              className="w-full rounded-full bg-white px-8 py-3 font-bold text-ink transition hover:bg-mint"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </FocusTrap>
  );
}
