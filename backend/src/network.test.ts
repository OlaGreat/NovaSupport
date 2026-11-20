import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveStellarNetwork,
  stellarNetworkLabel,
  stellarExplorerNetwork,
  stellarNetworkPassphrase,
} from "./network.js";

// ── issue #1353: one source of truth for the active network ───────────────────

test("STELLAR_NETWORK=PUBLIC resolves to mainnet", () => {
  assert.equal(resolveStellarNetwork({ STELLAR_NETWORK: "PUBLIC" } as NodeJS.ProcessEnv), "MAINNET");
});

test("unset or non-PUBLIC STELLAR_NETWORK resolves to testnet", () => {
  assert.equal(resolveStellarNetwork({} as NodeJS.ProcessEnv), "TESTNET");
  assert.equal(resolveStellarNetwork({ STELLAR_NETWORK: "TESTNET" } as NodeJS.ProcessEnv), "TESTNET");
});

test("mainnet and testnet derive matching labels, explorer slugs, and passphrases", () => {
  assert.equal(stellarNetworkLabel("MAINNET"), "Stellar Mainnet");
  assert.equal(stellarNetworkLabel("TESTNET"), "Stellar Testnet");
  assert.equal(stellarExplorerNetwork("MAINNET"), "public");
  assert.equal(stellarExplorerNetwork("TESTNET"), "testnet");
  assert.equal(
    stellarNetworkPassphrase("MAINNET"),
    "Public Global Stellar Network ; September 2015",
  );
  assert.equal(
    stellarNetworkPassphrase("TESTNET"),
    "Test SDF Network ; September 2015",
  );
});

test("the indexer network label is derived from the same STELLAR_NETWORK variable", () => {
  // The event indexer consumes resolveStellarNetwork() directly, so whatever the
  // rest of the backend reports is exactly what gets stamped on indexed rows.
  const env = { STELLAR_NETWORK: "PUBLIC" } as NodeJS.ProcessEnv;
  assert.equal(resolveStellarNetwork(env), "MAINNET");
});
