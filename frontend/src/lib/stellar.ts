import {
  Asset,
  BASE_FEE,
  Horizon,
  Memo,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

import { HORIZON_URL, STELLAR_NETWORK, NETWORK_PASSPHRASE } from "./config";
import { CONTRACT_ID } from "./config";
import { contractClient } from "./contract-client";

// Re-export wallet utilities so callers can import from a single stellar module.
export {
  getAvailableWallets,
  getWalletAdapter,
  WalletError,
  mapWalletError,
} from "./wallet-adapters";
export type {
  WalletAdapter,
  WalletId,
  WalletErrorCode,
  SignTransactionOptions,
} from "./wallet-adapters";

export const stellarConfig = {
  horizonUrl: HORIZON_URL,
  stellarNetwork: STELLAR_NETWORK,
  networkPassphrase: getDefaultNetworkPassphrase(),
};

// #1327: the SDK throws on http:// URLs unless allowHttp is set, which would
// crash at module load when pointing at a local quickstart Horizon instance.
export const horizonServer = new Horizon.Server(stellarConfig.horizonUrl, {
  allowHttp: stellarConfig.horizonUrl.startsWith("http://"),
});

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

export type ValidationResult = {
  isValid: boolean;
  error?: string;
};

export function validateWalletAddress(rawAddress: string): ValidationResult {
  const address = rawAddress.trim();

  if (!address) {
    return { isValid: false, error: "Wallet address is required." };
  }

  if (address.length < 56) {
    return {
      isValid: false,
      error: "Wallet address must contain 56 characters.",
    };
  }

  if (address.length > 56) {
    return {
      isValid: false,
      error: "Wallet address must contain exactly 56 characters.",
    };
  }

  if (!address.startsWith("G")) {
    return { isValid: false, error: "Stellar addresses must start with G." };
  }

  if (!StrKey.isValidEd25519PublicKey(address)) {
    return { isValid: false, error: "Wallet address appears invalid." };
  }

  return { isValid: true };
}

// ─── #274: Stellar network failure handling ─────────────────────────────────
//
// Horizon calls fail in three flavours: transient network errors (timeouts,
// dropped connections), upstream 5xx responses, and 4xx responses we should
// surface immediately. The first two are retryable with exponential backoff;
// the third is a programmer / data error and bubbling it up unchanged is the
// right call.

export type StellarFailureKind =
  | "network"
  | "rate_limited"
  | "server_error"
  | "client_error"
  | "not_found"
  | "unknown";

export interface ClassifiedStellarError {
  kind: StellarFailureKind;
  retryable: boolean;
  /** User-facing copy. Safe to render verbatim. */
  userMessage: string;
  /** Optional HTTP status the upstream returned, when available. */
  status?: number;
}

export function classifyStellarError(error: unknown): ClassifiedStellarError {
  const status = extractStatus(error);
  if (status === 404) {
    return {
      kind: "not_found",
      retryable: false,
      userMessage:
        "The account or transaction was not found on the Stellar network.",
      status,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      retryable: true,
      userMessage:
        "The Stellar network is rate-limiting requests. Retrying shortly.",
      status,
    };
  }
  if (typeof status === "number" && status >= 500 && status < 600) {
    return {
      kind: "server_error",
      retryable: true,
      userMessage:
        "Stellar servers are having trouble responding. Retrying shortly.",
      status,
    };
  }
  if (typeof status === "number" && status >= 400 && status < 500) {
    return {
      kind: "client_error",
      retryable: false,
      userMessage:
        "The request was rejected by Stellar. Check your inputs and try again.",
      status,
    };
  }

  if (isAbortError(error)) {
    return {
      kind: "unknown",
      retryable: false,
      userMessage:
        "The Stellar request was cancelled. Please try again if needed.",
    };
  }

  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("etimedout") ||
    message.includes("econnrefused") ||
    message.includes("fetch failed")
  ) {
    return {
      kind: "network",
      retryable: true,
      userMessage:
        "Couldn't reach the Stellar network. Retrying — please keep this page open.",
    };
  }

  return {
    kind: "unknown",
    retryable: false,
    userMessage:
      "Something went wrong contacting the Stellar network. Please try again.",
  };
}

function extractStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const e = error as { status?: number; response?: { status?: number } };
  if (typeof e.status === "number") return e.status;
  if (typeof e.response?.status === "number") return e.response.status;
  return undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "";
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "string") return error.toLowerCase().includes("abort");
  if (typeof error !== "object") return false;
  const e = error as { name?: string; code?: string; message?: string };
  return (
    e.name === "AbortError" ||
    e.code === "ABORT_ERR" ||
    e.message?.toLowerCase().includes("abort") === true
  );
}

export interface RetryOptions {
  /** Maximum total attempts (initial + retries). Defaults to 4. */
  maxAttempts?: number;
  /** First backoff delay in ms; doubled on each retry. Defaults to 250. */
  baseDelayMs?: number;
  /** Cap each individual sleep to this. Defaults to 4000. */
  maxDelayMs?: number;
  /**
   * Optional callback fired before each retry attempt. The host UI uses this
   * to surface "retrying… (attempt 2 of 4)" copy without leaking the raw
   * error to the user. Index is 1-based.
   */
  onRetry?: (info: {
    attempt: number;
    nextDelayMs: number;
    error: ClassifiedStellarError;
  }) => void;
}

/**
 * Run `fn` with retry + exponential backoff for transient Stellar failures.
 *
 * Non-retryable errors (4xx other than 429, programmer errors) propagate
 * immediately so the caller can surface a precise message. Retryable errors
 * (network, 429, 5xx) sleep with `baseDelayMs * 2^(attempt-1)` plus 0–25%
 * jitter, capped at `maxDelayMs`.
 */
export async function withStellarRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 4,
    baseDelayMs = 250,
    maxDelayMs = 4_000,
    onRetry,
  } = options;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const classified = classifyStellarError(err);
      if (!classified.retryable || attempt === maxAttempts) {
        throw err;
      }
      const exp = baseDelayMs * 2 ** (attempt - 1);
      const jittered = exp + Math.floor(Math.random() * exp * 0.25);
      const sleepMs = Math.min(jittered, maxDelayMs);
      onRetry?.({ attempt, nextDelayMs: sleepMs, error: classified });
      await sleep(sleepMs);
    }
  }
  // Unreachable — the for loop either returns or throws.
  throw lastError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getNetworkLabel(): string {
  return stellarConfig.stellarNetwork === "PUBLIC" ? "Mainnet" : "Testnet";
}

export function stellarExpertUrl(
  type: "tx" | "account" | "contract",
  id: string,
): string {
  const net = stellarConfig.stellarNetwork === "PUBLIC" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/${type}/${id}`;
}

/**
 * Returns true when `address` is a muxed (M…) Stellar account address.
 * Muxed addresses are valid supporter addresses but the Stellar Expert
 * account route cannot resolve them directly.
 */
export function isMuxedAddress(address: string): boolean {
  try {
    return StrKey.isValidMed25519PublicKey(address);
  } catch {
    return false;
  }
}

/**
 * Builds a Stellar Expert account URL that is safe for both G… and M…
 * addresses. For muxed addresses we resolve to the underlying G… account
 * (the first 32 bytes of the decoded M address) instead of emitting a URL
 * the explorer cannot resolve. Returns null for unrecognised addresses.
 */
export function stellarExpertAccountUrl(address: string): string | null {
  const net = stellarConfig.stellarNetwork === "PUBLIC" ? "public" : "testnet";

  if (StrKey.isValidEd25519PublicKey(address)) {
    return `https://stellar.expert/explorer/${net}/account/${address}`;
  }

  if (isMuxedAddress(address)) {
    const raw = StrKey.decodeMed25519PublicKey(address);
    const baseAddress = StrKey.encodeEd25519PublicKey(raw.subarray(0, 32));
    return `https://stellar.expert/explorer/${net}/account/${baseAddress}`;
  }

  return null;
}

export function getDefaultNetworkPassphrase(): string {
  return NETWORK_PASSPHRASE;
}

type SupportIntentInput = {
  sourceAccount: string;
  destination: string;
  amount: string;
  memo?: string;
  assetCode?: string;
  assetIssuer?: string;
  sequence?: string;
};

export async function buildSupportIntent({
  sourceAccount,
  destination,
  amount,
  memo,
  assetCode,
  assetIssuer,
  sequence,
}: SupportIntentInput) {
  // Prefer Soroban contract invocation when a contract ID is configured.
  if (CONTRACT_ID) {
    try {
      const contractXdr = await contractClient.buildSupportTransaction({
        sourceAccount,
        destination,
        amount,
        memo,
        assetCode,
        assetIssuer,
        sequence,
      });

      if (contractXdr) return contractXdr;
    } catch (err) {
      // If contract client/build fails, fall back to a native payment transaction.
      // Keep the error local and continue with the payment flow.
      // eslint-disable-next-line no-console
      console.warn(
        "contract build failed, falling back to payment intent:",
        err,
      );
    }
  }
  const account = sequence
    ? {
        accountId: () => sourceAccount,
        sequenceNumber: () => sequence,
        incrementSequenceNumber: () => undefined,
      }
    : await withStellarRetry(() => horizonServer.loadAccount(sourceAccount));

  const asset =
    assetCode && assetIssuer
      ? new Asset(assetCode, assetIssuer)
      : Asset.native();

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset,
        amount,
      }),
    )
    .setTimeout(30);

  if (memo) {
    transaction.addMemo(Memo.text(memo));
  }

  return transaction.build().toXDR();
}

export type PathPaymentIntentInput = {
  sourceAccount: string;
  sourceAsset: Asset;
  sourceAmount: string;
  destAsset: Asset;
  destAddress: string;
  slippageTolerance?: number; // default 0.02
  memo?: string;
};

export async function buildPathPaymentIntent({
  sourceAccount,
  sourceAsset,
  sourceAmount,
  destAsset,
  destAddress,
  slippageTolerance = 0.02,
  memo,
}: PathPaymentIntentInput) {
  const paths = await withStellarRetry(() =>
    horizonServer
      .strictSendPaths(sourceAsset, sourceAmount, [destAsset])
      .call(),
  );

  if (paths.records.length === 0) {
    throw new Error(
      `No DEX path found from ${sourceAsset.getCode()} to ${destAsset.getCode()}`,
    );
  }

  const bestPath = paths.records[0];
  const estimatedDestAmount = bestPath.destination_amount;
  const destMin = calculateDestinationMinimum(
    estimatedDestAmount,
    slippageTolerance,
  );

  const account = await withStellarRetry(() =>
    horizonServer.loadAccount(sourceAccount),
  );

  const transaction = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: sourceAsset,
        sendAmount: sourceAmount,
        destination: destAddress,
        destAsset: destAsset,
        destMin: destMin,
        path: bestPath.path.map((p: any) =>
          p.asset_type === "native"
            ? Asset.native()
            : new Asset(p.asset_code, p.asset_issuer),
        ),
      }),
    )
    .setTimeout(30);

  if (memo) {
    transaction.addMemo(Memo.text(memo));
  }

  return transaction.build().toXDR();
}

export function calculateDestinationMinimum(
  amount: string,
  slippageTolerance: number,
): string {
  if (
    !Number.isFinite(slippageTolerance) ||
    slippageTolerance < 0 ||
    slippageTolerance >= 1
  ) {
    throw new Error("Slippage tolerance must be between 0 and 1.");
  }

  const [amountInteger, amountFraction = ""] = amount.split(".");
  if (!/^\d+$/.test(amountInteger) || !/^\d*$/.test(amountFraction)) {
    throw new Error("Stellar amount must be a decimal number.");
  }

  const amountScale = 10n ** BigInt(amountFraction.length);
  const amountNumerator =
    BigInt(amountInteger) * amountScale + BigInt(amountFraction || "0");
  // Convert slippage to a fixed-decimal string before splitting so that
  // very small values (e.g. 0.0000001) don't arrive as exponential notation
  // ("1e-7"), which would cause BigInt() to throw a SyntaxError.
  // toFixed(20) gives enough decimal places for any value in [0, 1).
  const slippageText =
    slippageTolerance.toFixed(20).replace(/\.?0+$/, "") || "0";
  const [slippageInteger, slippageFraction = ""] = slippageText.split(".");
  const slippageScale = 10n ** BigInt(slippageFraction.length);
  const slippageNumerator =
    BigInt(slippageInteger) * slippageScale + BigInt(slippageFraction || "0");
  const numerator =
    amountNumerator * (slippageScale - slippageNumerator) * 10n ** 7n;
  const denominator = amountScale * slippageScale;
  let minimumUnits = numerator / denominator;
  if ((numerator % denominator) * 2n >= denominator) {
    minimumUnits += 1n;
  }

  const whole = minimumUnits / 10n ** 7n;
  const fraction = (minimumUnits % 10n ** 7n).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}
