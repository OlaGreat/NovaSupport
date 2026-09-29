"use client";

import { useEffect, useMemo, useState, useCallback, KeyboardEvent } from "react";
import { useToast } from "@/lib/use-toast";
import {
  Asset as StellarAsset,
  BASE_FEE,
  Horizon,
  TransactionBuilder,
  Transaction,
  FeeBumpTransaction,
} from "@stellar/stellar-sdk";
import {
  buildSupportIntent,
  buildPathPaymentIntent,
  getNetworkLabel,
  horizonServer,
  stellarConfig,
  withStellarRetry,
  classifyStellarError,
} from "@/lib/stellar";
import {
  getWalletAdapter,
  mapWalletError,
  type WalletId,
} from "@/lib/wallet-adapters";
import { WalletConnect } from "./wallet-connect";
import { TransactionResultModal } from "./transaction-result-modal";
import { API_BASE_URL, STELLAR_NETWORK } from "@/lib/config";
import { formatRateLimitedMessage, parseRateLimitInfo } from "@/lib/rate-limit";
import { apiFetch } from "@/lib/api-client";

type Asset = {
  code: string;
  issuer?: string | null;
};

const FEE_IN_XLM = Number(BASE_FEE) / 10_000_000;

/**
 * True when a Horizon balance line matches one of the creator's accepted
 * assets. Native XLM never has an issuer, so an accepted XLM without an
 * issuer matches any native balance. For non-native assets an explicit
 * issuer is required — a missing issuer no longer acts as a wildcard.
 */
function isAcceptedBalance(balance: any, acceptedAssets: Asset[]): boolean {
  return acceptedAssets.some((asset) => {
    if (balance.asset_type === "native") {
      return asset.code === "XLM" && !asset.issuer;
    }
    return (
      asset.code === balance.asset_code &&
      !!asset.issuer &&
      asset.issuer === balance.asset_issuer
    );
  });
}

function balanceKey(balance: any): string {
  return balance.asset_type === "native"
    ? "native"
    : `${balance.asset_code}:${balance.asset_issuer}`;
}
const IS_TESTNET = STELLAR_NETWORK !== "PUBLIC";

/**
 * Truncates a string so its UTF-8 byte representation is at most
 * STELLAR_MEMO_BYTE_LIMIT bytes (Stellar's hard limit for TEXT memos).
 * Plain `.slice(0, 28)` counts UTF-16 code units, not bytes, so multibyte
 * characters (emoji, non-Latin scripts) can still exceed the limit after
 * that "truncation". We encode to UTF-8 via TextEncoder, slice the byte
 * array, then decode — being careful not to cut in the middle of a
 * multibyte sequence by shortening until the decode round-trips cleanly.
 */
const STELLAR_MEMO_BYTE_LIMIT = 28;
function truncateMemoToStellarLimit(input: string): string {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let bytes = encoder.encode(input);
  if (bytes.length <= STELLAR_MEMO_BYTE_LIMIT) return input;
  bytes = bytes.slice(0, STELLAR_MEMO_BYTE_LIMIT);
  // Walk back until the slice is valid UTF-8 (no broken multibyte tail).
  while (bytes.length > 0) {
    const decoded = decoder.decode(bytes);
    // Check if the decoded string contains the replacement character (U+FFFD)
    // that indicates we've cut in the middle of a multibyte sequence.
    // If so, we must back off further to ensure a clean truncation boundary.
    if (decoded.includes("�")) {
      bytes = bytes.slice(0, bytes.length - 1);
      continue;
    }
    if (encoder.encode(decoded).length === bytes.length) return decoded;
    bytes = bytes.slice(0, bytes.length - 1);
  }
  return "";
}

type SupportPanelProps = {
  walletAddress: string;
  acceptedAssets?: Asset[];
  profileId?: string;
  recipientDisplayName?: string;
};

export function SupportPanel({
  walletAddress,
  acceptedAssets,
  profileId,
  recipientDisplayName = "Creator",
}: SupportPanelProps) {
  const paymentAssetSelectId = "support-payment-asset";
  const amountInputId = "support-amount";
  const amountErrorId = "support-amount-error";
  const balanceErrorId = "support-balance-error";
  const messageInputId = "support-message";
  const recurringToggleId = "support-recurring-toggle";
  const frequencyGroupId = "support-frequency";

  const [visitorAddress, setVisitorAddress] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [assetCode, setAssetCode] = useState("XLM");
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [accountNotFound, setAccountNotFound] = useState(false);
  const [copied, setCopied] = useState(false);
  const [paymentAsset, setPaymentAsset] = useState<{
    code: string;
    issuer?: string;
  }>({ code: "XLM" });
  const [visitorBalances, setVisitorBalances] = useState<any[]>([]);
  const [visitorBalancesLoaded, setVisitorBalancesLoaded] = useState(false);
  const [estimatedReceived, setEstimatedReceived] = useState<string | null>(
    null,
  );
  const [noPathFound, setNoPathFound] = useState(false);
  const [message, setMessage] = useState("");
  const [isRecurring, setIsRecurring] = useState(false);
  const [frequency, setFrequency] = useState<"weekly" | "monthly">("monthly");
  const [sending, setSending] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Values captured at submit time so the result modal can keep displaying them
  // after the live form fields are cleared (#708).
  const [submittedAmount, setSubmittedAmount] = useState("");
  const [submittedMessage, setSubmittedMessage] = useState("");
  const { showToast } = useToast();

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // silently fail
    }
  }, [walletAddress]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "c") {
        e.preventDefault();
        handleCopy();
      }
    },
    [handleCopy],
  );

  const isXlmPayment = paymentAsset.code === "XLM";

  const handleSend = useCallback(async () => {
    const parsedAmt = parseFloat(amount);
    const validAmount = !isNaN(parsedAmt) && parsedAmt > 0;
    const selectedBalStr = isXlmPayment
      ? (visitorBalances.find((b: any) => b.asset_type === "native")
          ?.balance ?? balance)
      : visitorBalances.find(
          (b: any) =>
            b.asset_type !== "native" &&
            b.asset_code === paymentAsset.code &&
            (!paymentAsset.issuer || b.asset_issuer === paymentAsset.issuer),
        )?.balance;
    const parsedBal = selectedBalStr ? parseFloat(selectedBalStr) : 0;
    const overBalance = isXlmPayment
      ? validAmount && parsedAmt + FEE_IN_XLM > parsedBal
      : validAmount && parsedAmt > parsedBal;
    if (!visitorAddress || !validAmount || overBalance || sending) return;

    const walletId = (
      typeof localStorage !== "undefined"
        ? localStorage.getItem("walletId")
        : null
    ) as WalletId | null;
    const adapter = walletId ? getWalletAdapter(walletId) : null;
    if (!adapter) {
      showToast(
        "Wallet not connected — please reconnect and try again.",
        "error",
      );
      return;
    }

    setSending(true);
    try {
      let xdr: string;
      const isPathPayment = paymentAsset.code !== "XLM";
      if (isPathPayment) {
        const srcAsset = paymentAsset.issuer
          ? new StellarAsset(paymentAsset.code, paymentAsset.issuer)
          : StellarAsset.native();
        xdr = await buildPathPaymentIntent({
          sourceAccount: visitorAddress,
          sourceAsset: srcAsset,
          sourceAmount: amount,
          destAsset: StellarAsset.native(),
          destAddress: walletAddress,
          memo: message || undefined,
        });
      } else {
        xdr = await buildSupportIntent({
          sourceAccount: visitorAddress,
          destination: walletAddress,
          amount,
          assetCode: paymentAsset.code,
          assetIssuer: paymentAsset.issuer,
          memo: message || undefined,
        });
      }

      const signedXdr = await adapter.signTransaction(xdr, {
        networkPassphrase: stellarConfig.networkPassphrase,
        address: visitorAddress,
      });

      const tx = TransactionBuilder.fromXDR(
        signedXdr,
        stellarConfig.networkPassphrase,
      ) as Transaction | FeeBumpTransaction;
      const result = await horizonServer.submitTransaction(tx);
      setTxHash(result.hash);
      // Snapshot the submitted values so the result modal keeps showing them,
      // then clear the form fields. This prevents the user from accidentally
      // re-sending the same amount/message once the modal closes (#708).
      setSubmittedAmount(amount);
      setSubmittedMessage(message);
      setAmount("");
      setMessage("");

      if (isRecurring && profileId) {
        const recurringRes = await apiFetch(`${API_BASE_URL}/v1/recurring-support`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            profileId,
            amount,
            assetCode: paymentAsset.code,
            assetIssuer: paymentAsset.issuer || undefined,
            frequency,
          }),
        });
        if (!recurringRes.ok) {
          const body = (await recurringRes.json().catch(() => ({}))) as Record<
            string,
            unknown
          >;
          showToast(
            typeof body.error === "string"
              ? body.error
              : "Payment succeeded, but recurring support could not be enabled.",
            "error",
          );
        }
      }

      await loadBalance(visitorAddress);
    } catch (err: unknown) {
      showToast(mapWalletError(err), "error");
    } finally {
      setSending(false);
    }
  }, [
    visitorAddress,
    amount,
    balance,
    visitorBalances,
    sending,
    paymentAsset,
    walletAddress,
    message,
    isRecurring,
    profileId,
    frequency,
    showToast,
    isXlmPayment,
  ]);

  const loadBalance = async (address: string) => {
    if (!address) return;
    setBalanceLoading(true);
    setBalanceError(null);
    setAccountNotFound(false);

    try {
      const account = await horizonServer.loadAccount(address);
      const xlmBalance = account.balances.find(
        (b: any) => b.asset_type === "native",
      );
      setBalance(xlmBalance ? xlmBalance.balance : "0");
    } catch (err: any) {
      if (err?.response?.status === 404 || err?.status === 404) {
        setAccountNotFound(true);
        setBalance("0");
        if (!IS_TESTNET) {
          setBalanceError("Account not found on Stellar network");
        }
      } else {
        setBalanceError("Failed to load balance");
      }
    } finally {
      setBalanceLoading(false);
    }
  };

  useEffect(() => {
    if (visitorAddress) {
      loadBalance(visitorAddress);
    }
  }, [visitorAddress]);

  useEffect(() => {
    if (!visitorAddress) return;
    const address = visitorAddress;
    async function fetchBalances() {
      try {
        const account = await horizonServer.loadAccount(address);
        setVisitorBalances(account.balances as any[]);
      } catch {
        setVisitorBalances([]);
      } finally {
        setVisitorBalancesLoaded(true);
      }
    }
    fetchBalances();
  }, [visitorAddress]);

  // Only offer assets the creator has declared as accepted (#1128). When the
  // creator has not configured any, fall back to the full wallet.
  const payableBalances = useMemo(
    () =>
      acceptedAssets && acceptedAssets.length > 0
        ? visitorBalances.filter((b: any) => isAcceptedBalance(b, acceptedAssets))
        : visitorBalances,
    [visitorBalances, acceptedAssets],
  );

  // Keep the selected asset within the payable set.
  useEffect(() => {
    if (payableBalances.length === 0) return;
    const selectedKey =
      paymentAsset.code === "XLM"
        ? "native"
        : `${paymentAsset.code}:${paymentAsset.issuer}`;
    if (payableBalances.some((b: any) => balanceKey(b) === selectedKey)) return;
    const first = payableBalances[0];
    setPaymentAsset(
      first.asset_type === "native"
        ? { code: "XLM" }
        : { code: first.asset_code, issuer: first.asset_issuer },
    );
  }, [payableBalances, paymentAsset]);

  const parsedAmount = parseFloat(amount);
  const hasValidAmount = !isNaN(parsedAmount) && parsedAmount > 0;
  const selectedBalanceStr = isXlmPayment
    ? (visitorBalances.find((b: any) => b.asset_type === "native")?.balance ??
      balance)
    : visitorBalances.find(
        (b: any) =>
          b.asset_type !== "native" &&
          b.asset_code === paymentAsset.code &&
          (!paymentAsset.issuer || b.asset_issuer === paymentAsset.issuer),
      )?.balance;
  const parsedBalance = selectedBalanceStr
    ? parseFloat(selectedBalanceStr)
    : 0;
  const totalNeeded = hasValidAmount
    ? isXlmPayment
      ? parsedAmount + FEE_IN_XLM
      : parsedAmount
    : 0;
  const insufficientBalance = hasValidAmount && totalNeeded > parsedBalance;
  const networkLabel = getNetworkLabel();
  const isBalanceLoading = balanceLoading;
  const isAccountFunded = !accountNotFound && balance !== null;
  const availableBalance = parsedBalance;
  const showError = !hasValidAmount && amount !== "";
  const isOverBalance = insufficientBalance;
  const isValidAmount = hasValidAmount;
  const recipientAsset = { code: "XLM" };

  const xlmBalance = parseFloat(
    visitorBalances.find((b) => b.asset_type === "native")?.balance ?? "0"
  );
  const paymentAssetAccepted = payableBalances.some(
    (b: any) =>
      balanceKey(b) ===
      (isXlmPayment ? "native" : `${paymentAsset.code}:${paymentAsset.issuer}`),
  );

  const insufficientXlmForFee =
    !isXlmPayment && hasValidAmount && xlmBalance < FEE_IN_XLM;

  if (!visitorAddress) {
    return (
      <section className="rounded-[2rem] border border-gold/25 bg-gold/10 p-7 text-center">
        <div className="mb-4">
          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
            {getNetworkLabel()}
          </span>
        </div>
        <p className="mb-4 text-sm text-sky/85">
          Connect your Stellar wallet to support this creator.
        </p>
        <WalletConnect onConnect={setVisitorAddress} />
      </section>
    );
  }

  return (
    <section className="rounded-[2rem] border border-gold/25 bg-gold/10 p-7">
      <div className="mb-4">
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-yellow-100 text-yellow-800">
          {getNetworkLabel()}
        </span>
      </div>

      <div className="mb-6">
        <p className="text-xs uppercase tracking-[0.25em] text-gold mb-2">
          Recipient Address
        </p>
        <div className="flex items-center p-3 rounded-xl bg-white/5 border border-white/10 group">
          <code
            onKeyDown={handleKeyDown}
            tabIndex={0}
            aria-label={`Recipient Stellar wallet address: ${walletAddress}. Press Ctrl+C to copy.`}
            className="text-xs text-indigo-400 font-mono break-all flex-1 focus:outline-none focus:ring-1 focus:ring-mint/50 rounded p-1"
          >
            {walletAddress}
          </code>
          <button
            onClick={handleCopy}
            aria-label="Copy recipient address to clipboard"
            title="Copy to clipboard"
            className="ml-2 p-1.5 text-gray-400 hover:text-white transition-colors focus:outline-none focus:ring-1 focus:ring-mint/50 rounded"
          >
            {copied ? (
              <span className="text-mint flex items-center gap-1 text-[10px] font-bold">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-3 w-3"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                    clipRule="evenodd"
                  />
                </svg>
                Copied
              </span>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 12-2h2a2 2 0 12 2m0 0[...]"
                />
              </svg>
            )}
          </button>
        </div>
      </div>

      <p className="text-xs uppercase tracking-[0.25em] text-gold">
        Support intent
      </p>
      <h2 className="mt-3 text-2xl font-semibold text-white">
        Select assets &amp; support
      </h2>

      <div className="mt-6 space-y-4">
        {/* Payment Asset Selector */}
        <div>
          <label
            htmlFor={paymentAssetSelectId}
            className="text-xs uppercase tracking-[0.2em] text-sky/70 block mb-2"
          >
            Pay with
          </label>
          {visitorBalancesLoaded && payableBalances.length === 0 ? (
            <p className="rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-sky/60">
              {visitorBalances.length === 0
                ? "Your wallet has no supported assets. Fund your wallet to continue."
                : `Your wallet holds none of the assets ${recipientDisplayName} accepts (${acceptedAssets
                    ?.map((a) => a.code)
                    .join(", ")}).`}
            </p>
          ) : (
            <select
              id={paymentAssetSelectId}
              aria-label="Payment asset"
              value={
                paymentAsset
                  ? paymentAsset.code === "XLM"
                    ? "native"
                    : `${paymentAsset.code}:${paymentAsset.issuer}`
                  : ""
              }
              onChange={(e) => {
                const val = e.target.value;
                if (val === "native") setPaymentAsset({ code: "XLM" });
                else {
                  const [code, issuer] = val.split(":");
                  setPaymentAsset({ code, issuer });
                }
              }}
              className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white focus:border-mint/50 focus:outline-none appearance-none"
            >
              {payableBalances.map((b: any) => (
                <option
                  key={balanceKey(b)}
                  value={balanceKey(b)}
                  className="bg-ink text-white"
                >
                  {b.asset_type === "native" ? "XLM" : b.asset_code} (
                  {parseFloat(b.balance).toFixed(2)})
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Amount Input */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label
              htmlFor={amountInputId}
              className="text-xs uppercase tracking-[0.2em] text-sky/70"
            >
              Amount
            </label>
            {visitorAddress && (
              <div
                className="text-[10px] font-medium text-sky/50"
                aria-live="polite"
                aria-atomic="true"
              >
                {isBalanceLoading ? (
                  <span className="animate-pulse">Fetching balance...</span>
                ) : !isAccountFunded ? (
                  <a
                    href="https://laboratory.stellar.org/#friendbot"
                    target="_blank"
                    className="text-yellow-500 hover:underline"
                  >
                    Account not funded (Testnet)
                  </a>
                ) : (
                  <span>
                    Available: {availableBalance.toFixed(2)}{" "}
                    {paymentAsset?.code || "XLM"}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <input
              id={amountInputId}
              type="number"
              min="0.0000001"
              step="0.0000001"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              aria-label="Support amount"
              aria-describedby={`${amountErrorId} ${balanceErrorId}`}
              aria-invalid={Boolean(
                showError || (isOverBalance && isValidAmount),
              )}
              className="flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-sky/50 focus:border-mint/50 focus:outline-none"
            />
            <div className="flex items-center rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-sky/80 min-w-[80px] justify-center">
              <span className="font-semibold text-white">
                {paymentAsset?.code || "XLM"}
              </span>
            </div>
          </div>
          {showError && (
            <p id={amountErrorId} className="mt-2 text-xs text-red-400">
              Please enter a positive amount
            </p>
          )}
          {isOverBalance && isValidAmount && (
            <p id={balanceErrorId} className="mt-2 text-xs text-red-400">
              Insufficient balance (Limit: {availableBalance.toFixed(7)})
            </p>
          )}
        </div>

        {estimatedReceived && (
          <div className="p-3 rounded-xl bg-white/5 border border-white/5">
            <p className="text-xs text-mint text-center">
              Creator receives ~{parseFloat(estimatedReceived).toFixed(4)}{" "}
              {recipientAsset.code}
            </p>
          </div>
        )}

        {noPathFound && (
          <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20">
            <p className="text-xs text-red-400 text-center">
              No DEX path found from {paymentAsset?.code} to{" "}
              {recipientAsset.code}
            </p>
            <p className="text-xs text-red-300/70 text-center mt-1">
              Try sending XLM directly or choose a different payment asset.
            </p>
          </div>
        )}
      </div>

      {/* Message Input */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-2">
          <label
            htmlFor={messageInputId}
            className="text-xs uppercase tracking-[0.2em] text-sky/70"
          >
            Leave a message (optional)
          </label>
          <span
            className={`text-[10px] font-medium ${new TextEncoder().encode(message).length >= 28 ? "text-red-400" : "text-sky/40"}`}
          >
            {new TextEncoder().encode(message).length} / 28
          </span>
        </div>
        <textarea
          id={messageInputId}
          value={message}
          onChange={(e) => setMessage(truncateMemoToStellarLimit(e.target.value))}
          placeholder="e.g. Keep up the great work!"
          rows={2}
          aria-label="Optional message to the creator"
          className="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-sky/30 focus:border-mint/50 focus:outline-none resize-none"
        />
      </div>

      {/* Recurring Support Toggle */}
      <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            id={recurringToggleId}
            type="checkbox"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.target.checked)}
            aria-label="Make support recurring"
            className="h-4 w-4 rounded border-white/20 bg-white/10 text-mint focus:ring-mint focus:ring-offset-0"
          />
          <span className="text-sm text-white font-medium">
            Make it recurring
          </span>
        </label>

        {isRecurring && (
          <div className="mt-4">
            <label
              id={frequencyGroupId}
              className="text-xs uppercase tracking-[0.2em] text-sky/70 block mb-2"
            >
              Frequency
            </label>
            <div
              className="flex gap-2"
              role="group"
              aria-labelledby={frequencyGroupId}
            >
              <button
                type="button"
                onClick={() => setFrequency("weekly")}
                aria-label="Set recurring frequency to weekly"
                className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition ${
                  frequency === "weekly"
                    ? "bg-mint text-ink"
                    : "border border-white/10 bg-white/5 text-white hover:bg-white/10"
                }`}
              >
                Weekly
              </button>
              <button
                type="button"
                onClick={() => setFrequency("monthly")}
                aria-label="Set recurring frequency to monthly"
                className={`flex-1 rounded-xl px-4 py-2 text-sm font-medium transition ${
                  frequency === "monthly"
                    ? "bg-mint text-ink"
                    : "border border-white/10 bg-white/5 text-white hover:bg-white/10"
                }`}
              >
                Monthly
              </button>
            </div>
          </div>
        )}
      </div>

      {accountNotFound && IS_TESTNET && (
        <div className="mt-4 rounded-2xl border border-gold/20 bg-gold/5 p-4">
          <p className="text-sm text-sky/85">
            Your account isn&apos;t funded on Testnet yet.
          </p>
          <div className="mt-3 flex items-center gap-3">
            <a
              href={`https://friendbot.stellar.org/?addr=${visitorAddress}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-lg bg-mint px-4 py-2 text-xs font-semibold text-black hover:bg-mint/90 transition-colors"
            >
              Fund with Friendbot &rarr;
            </a>
            <button
              onClick={() => loadBalance(visitorAddress)}
              disabled={balanceLoading}
              className="rounded-lg bg-white/5 px-4 py-2 text-xs font-semibold text-steel hover:bg-white/10 transition-colors disabled:opacity-50"
            >
              {balanceLoading ? "Refreshing..." : "Refresh balance"}
            </button>
          </div>
        </div>
      )}

      {accountNotFound && !IS_TESTNET && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
          <p className="text-sm text-red-400">
            Account not found on Stellar network
          </p>
        </div>
      )}

      {balanceError && !accountNotFound && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-4">
          <p className="text-sm text-red-400">{balanceError}</p>
          <button
            onClick={() => loadBalance(visitorAddress)}
            disabled={balanceLoading}
            className="mt-2 rounded-lg bg-white/5 px-3 py-1 text-xs font-semibold text-steel hover:bg-white/10 transition-colors disabled:opacity-50"
          >
            {balanceLoading ? "Refreshing..." : "Refresh balance"}
          </button>
        </div>
      )}

      {hasValidAmount && (
        <div className="mt-4 rounded-2xl border border-white/5 bg-white/[0.03] p-3">
          <div className="flex items-center justify-between text-xs text-steel">
            <span>Network fee</span>
            <span className="tabular-nums">~{FEE_IN_XLM.toFixed(7)} XLM</span>
          </div>
          {assetCode !== "XLM" && (
            <p className="mt-1 text-[10px] text-steel/60">
              Path payments may incur slightly higher fees due to additional
              operations
            </p>
          )}
        </div>
      )}

      {insufficientBalance && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-xs text-red-400">
            Insufficient balance. You need at least {totalNeeded.toFixed(7)}{" "}
            {paymentAsset.code}
            {isXlmPayment
              ? ` (including ~${FEE_IN_XLM.toFixed(7)} XLM network fee)`
              : ""}
            .
          </p>
        </div>
      )}

      {insufficientXlmForFee && (
        <div className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/5 p-3">
          <p className="text-xs text-red-400">
            Insufficient XLM balance. You need at least {FEE_IN_XLM.toFixed(7)}{" "}
            XLM in your wallet to pay the Stellar network fee.
          </p>
        </div>
      )}

      <button
        type="button"
        onClick={handleSend}
        disabled={!hasValidAmount || insufficientBalance || insufficientXlmForFee || !paymentAssetAccepted || sending}
        className="mt-6 w-full rounded-lg bg-mint px-4 py-3 text-sm font-semibold text-black hover:bg-mint/90 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
      >
        {sending ? "Sending…" : "Send Support"}
      </button>

      <p className="mt-4 text-xs leading-6 text-steel">
        This builds and signs a Stellar payment using Freighter. The transaction
        hash is stored on the NovaSupport backend.
      </p>

      <TransactionResultModal
        txHash={txHash}
        amount={submittedAmount}
        assetCode={paymentAsset.code || "XLM"}
        recipientDisplayName={recipientDisplayName}
        note={submittedMessage || null}
        isOpen={txHash !== null}
        onClose={() => setTxHash(null)}
      />
    </section>
  );
}
