// Single source of truth for the active Stellar network.
//
// The rest of the backend (API responses, stellar.toml, email explorer links)
// resolves the active network from `STELLAR_NETWORK`. Every consumer — most
// importantly the Soroban event indexer — must derive it from the same variable.
// A separate, indexer-only variable previously let the indexer keep tagging rows
// as TESTNET (its own default) while the rest of the system had switched to
// mainnet, corrupting network-filtered queries and exports going forward (#1353).
//
// `STELLAR_NETWORK=PUBLIC` selects mainnet; any other value (or unset) is
// testnet, matching the existing behavior documented in `.env.example`.

export type StellarNetwork = "TESTNET" | "MAINNET";

/**
 * Resolve the active Stellar network from the environment. This is the single
 * source of truth used by API responses, email/explorer links, and the event
 * indexer alike.
 */
export function resolveStellarNetwork(
  env: NodeJS.ProcessEnv = process.env,
): StellarNetwork {
  return env.STELLAR_NETWORK === "PUBLIC" ? "MAINNET" : "TESTNET";
}

/** Human-readable network label (e.g. for `/health` and API responses). */
export function stellarNetworkLabel(
  network: StellarNetwork = resolveStellarNetwork(),
): string {
  return network === "MAINNET" ? "Stellar Mainnet" : "Stellar Testnet";
}

/** Network slug used in Stellar Expert explorer URLs. */
export function stellarExplorerNetwork(
  network: StellarNetwork = resolveStellarNetwork(),
): "public" | "testnet" {
  return network === "MAINNET" ? "public" : "testnet";
}

/** Network passphrase used in stellar.toml and transaction signing. */
export function stellarNetworkPassphrase(
  network: StellarNetwork = resolveStellarNetwork(),
): string {
  return network === "MAINNET"
    ? "Public Global Stellar Network ; September 2015"
    : "Test SDF Network ; September 2015";
}
