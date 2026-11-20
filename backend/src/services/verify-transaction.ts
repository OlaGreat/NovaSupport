import type { Horizon } from "@stellar/stellar-sdk";
import { logger } from "../logger.js";

export interface ExpectedTxDetails {
  amount: string;
  recipientAddress: string;
  assetCode: string;
  assetIssuer?: string | null;
  /**
   * The supporter the request claims to be. When set, the on-chain payer (`from`, or `funder` for account creation)
   * must be this address, so a real payment made by someone else cannot be credited to the claimant (#1473).
   */
  supporterAddress?: string | null;
}

// Module-level cache shared across all calls in the same process
const verificationCache = new Map<string, { result: boolean; timestamp: number }>();
export const VERIFICATION_CACHE_TTL = 60 * 60 * 1000; // 1 hour
export const NEGATIVE_CACHE_TTL = 30 * 1000; // 30 seconds for false/error results
const OPERATIONS_PAGE_SIZE = 100;
// Bound the cache to prevent unbounded memory growth — one entry per unique
// (txHash, expected) key, accumulated indefinitely otherwise (#923)
export const VERIFICATION_CACHE_MAX_SIZE = 5000;

// Non-numeric input normalizes to null so two malformed amounts never match.
function normalizeAmount(amount: string): string | null {
  const n = Number(amount);
  if (typeof amount !== "string" || amount.trim() === "" || !Number.isFinite(n)) return null;
  return n.toFixed(7);
}

function amountsMatch(a: string, b: string): boolean {
  const normalized = normalizeAmount(a);
  return normalized !== null && normalized === normalizeAmount(b);
}

export function clearVerificationCache(): void {
  verificationCache.clear();
}

function setCacheEntry(key: string, value: { result: boolean; timestamp: number }): void {
  verificationCache.set(key, value);
  // Evict the oldest entry when the cache exceeds the max size to prevent OOM
  // (same pattern as analytics.ts) (#923)
  if (verificationCache.size > VERIFICATION_CACHE_MAX_SIZE) {
    const oldest = verificationCache.keys().next().value;
    if (oldest !== undefined) verificationCache.delete(oldest);
  }
}

function makeCacheKey(txHash: string, expected?: ExpectedTxDetails): string {
  if (!expected) return txHash;
  return `${txHash}|${expected.recipientAddress}|${expected.amount}|${expected.assetCode}|${expected.assetIssuer ?? ""}|${expected.supporterAddress ?? ""}`;
}

/** True when no payer was claimed, or the operation's payer is the claimed supporter. */
function payerMatches(payer: string | undefined, expected: ExpectedTxDetails): boolean {
  if (!expected.supporterAddress) return true;
  return payer === expected.supporterAddress;
}

function isAssetMatch(
  op: { asset_type: string; asset_code?: string; asset_issuer?: string },
  assetCode: string,
  assetIssuer?: string | null
): boolean {
  const wantNative = assetCode === "XLM" || assetCode === "native";
  if (wantNative) return op.asset_type === "native";
  return op.asset_code === assetCode && op.asset_issuer === (assetIssuer ?? undefined);
}

// Scan the transaction's operations for a payment that matches all expected details.
// Supports `payment`, `create_account` (XLM-only), `path_payment_strict_send`,
// and `path_payment_strict_receive` operation types.
async function validatePaymentDetails(
  server: Horizon.Server,
  txHash: string,
  expected: ExpectedTxDetails
): Promise<boolean> {
  const operationRequest = server.operations().forTransaction(txHash);
  const limitedRequest =
    "limit" in operationRequest
      ? operationRequest.limit(OPERATIONS_PAGE_SIZE)
      : operationRequest;
  let ops = await limitedRequest.call();

  while (true) {
    for (const op of ops.records) {
      if (op.type === "payment") {
        const p = op as unknown as {
          from?: string;
          to: string;
          amount: string;
          asset_type: string;
          asset_code?: string;
          asset_issuer?: string;
        };
        if (
          p.to === expected.recipientAddress &&
          payerMatches(p.from, expected) &&
          amountsMatch(p.amount, expected.amount) &&
          isAssetMatch(p, expected.assetCode, expected.assetIssuer)
        ) {
          return true;
        }
      }

      if (op.type === "create_account") {
        const c = op as unknown as { account: string; funder?: string; starting_balance: string };
        const wantNative = expected.assetCode === "XLM" || expected.assetCode === "native";
        if (
          wantNative &&
          c.account === expected.recipientAddress &&
          payerMatches(c.funder, expected) &&
          amountsMatch(c.starting_balance, expected.amount)
        ) {
          return true;
        }
      }

      if (
        op.type === "path_payment_strict_send" ||
        op.type === "path_payment_strict_receive"
      ) {
        const p = op as unknown as {
          from?: string;
          to: string;
          destination_amount?: string;
          amount?: string;
          asset_type: string;
          asset_code?: string;
          asset_issuer?: string;
        };
        const receivedAmount =
          op.type === "path_payment_strict_receive"
            ? p.amount
            : p.destination_amount;

        if (
          p.to === expected.recipientAddress &&
          payerMatches(p.from, expected) &&
          receivedAmount !== undefined &&
          amountsMatch(receivedAmount, expected.amount) &&
          isAssetMatch(p, expected.assetCode, expected.assetIssuer)
        ) {
          return true;
        }
      }
    }

    if (!("next" in ops) || typeof ops.next !== "function") break;
    ops = await ops.next();
  }

  return false;
}

function isHorizon404(e: unknown): boolean {
  return (
    e != null &&
    typeof e === "object" &&
    "response" in e &&
    (e as { response: unknown }).response != null &&
    typeof (e as { response: unknown }).response === "object" &&
    "status" in ((e as { response: unknown }).response as object) &&
    ((e as { response: { status: unknown } }).response.status as number) === 404
  );
}

/**
 * Verify a Stellar transaction against Horizon.
 *
 * @param server   - Horizon.Server instance to query (injectable for testing)
 * @param txHash   - Transaction hash to verify
 * @param retries  - Number of attempts before throwing (default 3)
 * @param backoffMs - Base delay in ms; doubled on each retry (default 1000)
 * @param expected  - Optional payment details to validate against on-chain operations
 * @returns
 *   true    — transaction exists, is successful, and (if expected given) details match
 *   false   — transaction not found (404) or details mismatch (not an infrastructure failure)
 * @throws  When Horizon is unreachable or returns non-404 errors after all retries are
 *          exhausted, so callers (e.g. circuit breakers) can observe the failure.
 */
export async function verifyTransaction(
  server: Horizon.Server,
  txHash: string,
  retries = 3,
  backoffMs = 1000,
  expected?: ExpectedTxDetails
): Promise<boolean> {
  const cacheKey = makeCacheKey(txHash, expected);
  const cached = verificationCache.get(cacheKey);
  if (cached) {
    const ttl = cached.result === true ? VERIFICATION_CACHE_TTL : NEGATIVE_CACHE_TTL;
    if (Date.now() - cached.timestamp < ttl) {
      return cached.result;
    }
  }

  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const tx = await server.transactions().transaction(txHash).call();

      if (!tx.successful) {
        setCacheEntry(cacheKey, { result: false, timestamp: Date.now() });
        return false;
      }

      if (expected) {
        const valid = await validatePaymentDetails(server, txHash, expected);
        if (!valid) {
          setCacheEntry(cacheKey, { result: false, timestamp: Date.now() });
          return false;
        }
      }

      setCacheEntry(cacheKey, { result: true, timestamp: Date.now() });
      return true;
    } catch (e: unknown) {
      if (isHorizon404(e)) {
        // Definitive "not found" — not an infrastructure failure
        setCacheEntry(cacheKey, { result: false, timestamp: Date.now() });
        return false;
      }

      // Infrastructure failure — record and possibly retry
      lastError = e;
      if (attempt < retries) {
        const delay = backoffMs * Math.pow(2, attempt - 1);
        logger.warn({ txHash, attempt, delay }, "Horizon verification failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        logger.error({ txHash, err: e }, "Horizon error verifying transaction after all retries");
      }
    }
  }

  // All retries exhausted due to infrastructure failures — throw so circuit breakers
  // and other callers can observe and react to the outage.
  throw lastError;
}
