#!/usr/bin/env node
/**
 * Gas estimation script for the NovaSupport support() contract function.
 *
 * Usage:
 *   node estimate-gas.js
 *
 * Environment variables:
 *   RPC_URL             - Soroban RPC endpoint (default: testnet)
 *   NETWORK_PASSPHRASE  - Stellar network passphrase (default: testnet)
 *   CONTRACT_ID         - Deployed support_page contract address (required)
 *   SUPPORTER_SECRET    - Secret key for the simulated supporter account (required)
 *   RECIPIENT_ADDRESS   - G... address of the simulated recipient
 *
 * Prerequisites:
 *   npm install @stellar/stellar-sdk
 */

import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Address,
  nativeToScVal,
  Contract,
  Keypair,
} from "@stellar/stellar-sdk";

// ── Config ────────────────────────────────────────────────────────────────────
const RPC_URL =
  process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const CONTRACT_ID = process.env.CONTRACT_ID;
const SUPPORTER_SECRET = process.env.SUPPORTER_SECRET;

if (!CONTRACT_ID) {
  console.error(
    "ERROR: Set CONTRACT_ID env var to your deployed contract address.\n" +
      "  CONTRACT_ID=C... node estimate-gas.js",
  );
  process.exit(1);
}

if (!SUPPORTER_SECRET) {
  console.error(
    "ERROR: Set SUPPORTER_SECRET env var to a funded testnet secret key.\n" +
      "  SUPPORTER_SECRET=S... node estimate-gas.js",
  );
  process.exit(1);
}
const RECIPIENT_ADDRESS =
  process.env.RECIPIENT_ADDRESS ??
  "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

// XLM native asset address on testnet
const XLM_ASSET_ADDRESS = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

// ── Scenarios ─────────────────────────────────────────────────────────────────
const SCENARIOS = [
  {
    label: "Minimal (short message, small amount)",
    amount: 1_0000000n,           // 1 XLM in stroops
    message: "Nice work!",        // 10 chars
    assetCode: "XLM",
  },
  {
    label: "Medium (typical support)",
    amount: 5_0000000n,           // 5 XLM
    message: "Love what you're doing for the Stellar ecosystem — keep it up!",
    assetCode: "XLM",
  },
  {
    label: "Large amount, long message",
    amount: 100_0000000n,         // 100 XLM
    message:
      "This is a long support message that approaches the maximum allowed length " +
      "in order to illustrate how message size affects gas consumption. " +
      "Soroban charges per byte of contract arguments.",
    assetCode: "XLM",
  },
  {
    label: "Max message (280 chars)",
    amount: 10_0000000n,
    message: "A".repeat(280),
    assetCode: "XLM",
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function stroopsToXlm(stroops) {
  return (Number(stroops) / 10_000_000).toFixed(7);
}

function feeToXlm(stroops) {
  return (Number(stroops) / 10_000_000).toFixed(7);
}

async function estimateScenario(server, keypair, scenario) {
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "support",
        nativeToScVal(Address.fromString(keypair.publicKey()), { type: "address" }),
        nativeToScVal(Address.fromString(RECIPIENT_ADDRESS), { type: "address" }),
        nativeToScVal(Address.fromString(XLM_ASSET_ADDRESS), { type: "address" }),
        nativeToScVal(scenario.amount, { type: "i128" }),
        nativeToScVal(scenario.assetCode, { type: "string" }),
        nativeToScVal(scenario.message, { type: "string" }),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(sim)) {
    return { error: sim.error };
  }

  const { minResourceFee, result, cost } = sim;

  return {
    minResourceFee: minResourceFee ?? "0",
    cpuInstructions: cost?.cpuInsns ?? "unknown",
    memBytes: cost?.memBytes ?? "unknown",
    returnValue: result?.retval?.value()?.toString() ?? "n/a",
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const server = new SorobanRpc.Server(RPC_URL);
  const keypair = Keypair.fromSecret(SUPPORTER_SECRET);

  console.log("NovaSupport — support() Gas Estimation");
  console.log("═".repeat(60));
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Contract: ${CONTRACT_ID}`);
  console.log(`Account:  ${keypair.publicKey()}`);
  console.log();

  for (const scenario of SCENARIOS) {
    console.log(`Scenario: ${scenario.label}`);
    console.log(`  Amount:  ${stroopsToXlm(scenario.amount)} ${scenario.assetCode}`);
    console.log(`  Message: ${scenario.message.length} chars`);

    const result = await estimateScenario(server, keypair, scenario);

    if (result.error) {
      console.log(`  ⚠ Simulation error: ${result.error}`);
    } else {
      console.log(`  CPU Instructions: ${Number(result.cpuInstructions).toLocaleString()}`);
      console.log(`  Memory:           ${Number(result.memBytes).toLocaleString()} bytes`);
      console.log(`  Min Resource Fee: ${result.minResourceFee} stroops (${feeToXlm(result.minResourceFee)} XLM)`);
    }
    console.log();
  }

  console.log("─".repeat(60));
  console.log("Tip: actual fee = base fee + resource fee. Set a higher");
  console.log("BASE_FEE in congested periods to improve inclusion speed.");
}

main().catch((err) => {
  console.error("Fatal:", err.message ?? err);
  process.exit(1);
});
