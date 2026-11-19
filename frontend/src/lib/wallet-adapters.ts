/**
 * Wallet adapter pattern for Stellar wallets.
 * Provides a consistent interface across Freighter, Albedo, and Lobstr.
 */

import { Networks } from "@stellar/stellar-sdk";

export type WalletId = "freighter" | "albedo" | "lobstr";

export type WalletErrorCode =
  | "NOT_FOUND"
  | "CONNECTION_DENIED"
  | "SIGNING_DENIED"
  | "SIGNING_FAILED"
  | "UNKNOWN";

export class WalletError extends Error {
  constructor(
    message: string,
    public code: WalletErrorCode,
  ) {
    super(message);
    this.name = "WalletError";
  }
}

export interface SignTransactionOptions {
  address: string;
  networkPassphrase: string;
}

export interface WalletAdapter {
  id: WalletId;
  name: string;
  icon: string;
  isAvailable(): boolean;
  connect(): Promise<string>;
  signTransaction(xdr: string, options: SignTransactionOptions): Promise<string>;
}

// ─── Shared error mapping ─────────────────────────────────────────────────────

export function mapWalletError(error: unknown): string {
  if (error instanceof WalletError) {
    switch (error.code) {
      case "SIGNING_DENIED":
        return "You declined the transaction in your wallet.";
      case "NOT_FOUND":
        const baseMessage = error.message.endsWith(".") ? error.message.slice(0, -1) : error.message;
        return `${baseMessage}. Please install a Stellar wallet extension.`;
      case "CONNECTION_DENIED":
        return "Wallet access was not granted. Please allow the site and try again.";
      case "SIGNING_FAILED":
        return error.message || "Your wallet did not return a signed transaction.";
      default:
        return error.message || "An unexpected wallet error occurred.";
    }
  }
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

// ─── Freighter ────────────────────────────────────────────────────────────────

// Freighter reports a user decline as an error string. Other errors (network
// mismatch, extension fault) are failures, not declines, and must not be shown
// as "you declined".
const FREIGHTER_DECLINE_PATTERN = /reject|declin|denied|cancel/i;

function isFreighterDecline(message: string): boolean {
  return FREIGHTER_DECLINE_PATTERN.test(message);
}

const freighterAdapter: WalletAdapter = {
  id: "freighter",
  name: "Freighter",
  icon: "\u{1F6A2}", // ship
  isAvailable() {
    if (typeof window === "undefined") return false;
    return !!(window as any).freighter;
  },
  async connect() {
    const { getAddress, isAllowed, setAllowed } = await import(
      "@stellar/freighter-api"
    );
    const access = await isAllowed();
    if (!access.isAllowed) {
      const permission = await setAllowed();
      if (!permission.isAllowed)
        throw new WalletError("Freighter permission denied.", "CONNECTION_DENIED");
    }
    const result = await getAddress();
    if (result.error) {
      const message = String(result.error);
      throw new WalletError(
        message,
        isFreighterDecline(message) ? "CONNECTION_DENIED" : "UNKNOWN",
      );
    }
    return result.address;
  },
  async signTransaction(xdr, { address, networkPassphrase }) {
    const { signTransaction } = await import("@stellar/freighter-api");
    const result = await signTransaction(xdr, { address, networkPassphrase });
    if (result.error) {
      const message = String(result.error);
      throw new WalletError(
        message,
        isFreighterDecline(message) ? "SIGNING_DENIED" : "SIGNING_FAILED",
      );
    }
    if (!result.signedTxXdr)
      throw new WalletError("Freighter did not return a signed transaction.", "SIGNING_FAILED");
    return result.signedTxXdr;
  },
};

// ─── Albedo ───────────────────────────────────────────────────────────────────

const albedoAdapter: WalletAdapter = {
  id: "albedo",
  name: "Albedo",
  icon: "\u2600\uFE0F", // sun
  isAvailable() {
    if (typeof window === "undefined") return false;
    return !!(window as any).albedo;
  },
  async connect() {
    const albedo = (window as any).albedo;
    if (!albedo) throw new WalletError("Albedo extension not found.", "NOT_FOUND");
    const result = await albedo.publicKey({ require_existing: false });
    if (!result?.pubkey)
      throw new WalletError("Albedo did not return a public key.", "CONNECTION_DENIED");
    return result.pubkey;
  },
  async signTransaction(xdr, { networkPassphrase }) {
    const albedo = (window as any).albedo;
    if (!albedo) throw new WalletError("Albedo extension not found.", "NOT_FOUND");
    // Albedo's tx() expects the shorthand "public" | "testnet", not the full
    // network passphrase. Passing the passphrase makes every sign fail (#707).
    const network =
      networkPassphrase === Networks.PUBLIC ? "public" : "testnet";
    const result = await albedo.tx({ xdr, network });
    if (!result?.signed_envelope_xdr)
      throw new WalletError("Albedo did not return a signed transaction.", "SIGNING_FAILED");
    return result.signed_envelope_xdr;
  },
};

// ─── Lobstr ───────────────────────────────────────────────────────────────────

const lobstrAdapter: WalletAdapter = {
  id: "lobstr",
  name: "Lobstr",
  icon: "\u{1F99E}", // lobster
  isAvailable() {
    if (typeof window === "undefined") return false;
    return !!(window as any).lobstr;
  },
  async connect() {
    const lobstr = (window as any).lobstr;
    if (!lobstr) throw new WalletError("Lobstr extension not found.", "NOT_FOUND");
    const result = await lobstr.getPublicKey();
    if (!result) throw new WalletError("Lobstr did not return a public key.", "CONNECTION_DENIED");
    return result;
  },
  async signTransaction(xdr, { networkPassphrase }) {
    const lobstr = (window as any).lobstr;
    if (!lobstr) throw new WalletError("Lobstr extension not found.", "NOT_FOUND");
    const result = await lobstr.signTransaction(xdr, { networkPassphrase });
    if (!result?.signedTxXdr)
      throw new WalletError("Lobstr did not return a signed transaction.", "SIGNING_FAILED");
    return result.signedTxXdr;
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

const ALL_ADAPTERS: WalletAdapter[] = [
  freighterAdapter,
  albedoAdapter,
  lobstrAdapter,
];

export function getAvailableWallets(): WalletAdapter[] {
  return ALL_ADAPTERS.filter((a) => a.isAvailable());
}

export function getWalletAdapter(id: WalletId): WalletAdapter | undefined {
  return ALL_ADAPTERS.find((a) => a.id === id);
}

export function getStoredWalletAddress(): string | null {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    return null;
  }
  return localStorage.getItem("walletAddress");
}
