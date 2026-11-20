# NovaSupport Contract

This Soroban workspace contains a single minimal contract under `contracts/support_page/`.

## Purpose

The initial contract is intentionally small:

- accept a support action
- require supporter authorization
- emit a support event
- keep a simple support counter
- comprehensive error handling with specific error codes

## Error Handling

The contract now includes comprehensive error codes for better debugging and user experience. See [ERROR_CODES.md](ERROR_CODES.md) for detailed documentation of all error codes and their meanings.

Key error categories:

- **Input validation errors** (1-99): Invalid amounts, messages, asset codes
- **Authorization errors** (100-199): Admin access, recipient permissions
- **Contract state errors** (200-299): Initialization, pause state
- **Balance and transfer errors** (300-399): Insufficient funds, withdrawal limits
- **Storage and data errors** (400-499): Missing data, recipient not found

## Why It Is Small

The MVP only needs to show clear Soroban intent for the Stellar Wave submission. This contract is a safe extension point for future work such as:

- token transfer enforcement
- recurring support logic
- onchain profile ownership
- milestones or attestations

## Deployed Contract (Testnet)

| Field          | Value                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract ID    | `CDSIKFT4Z5UDWJ6BU5R7F7O6G6NCVXZ6GTNTPWFFOW6PHA2APK3PRR6U`                                                                                          |
| Deployer       | `GAYSFWP7XAVIEHWWTOPPD4MVZUOTIQQAVWZIPT6LSAF6PO3MIAKXLGQS`                                                                                          |
| Network        | Stellar Testnet                                                                                                                                       |
| Explorer       | https://stellar.expert/explorer/testnet/contract/CDSIKFT4Z5UDWJ6BU5R7F7O6G6NCVXZ6GTNTPWFFOW6PHA2APK3PRR6U                                           |

The contract ID is set as `NEXT_PUBLIC_CONTRACT_ID` in `frontend/.env.example`. Copy it to `frontend/.env.local` (not committed) for local development.

## Troubleshooting

If deployment or invocation fails, check the following first:

- Confirm the contract was deployed to the same network your client is using.
- Verify the contract ID in `frontend/.env.local` and any backend indexer env vars.
- Make sure the source account is funded before invoking the contract.
- Check the deployer and supporter addresses in Stellar Expert:
  https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>

### Common Deployment Errors

#### Error: "account not found"

**Cause:** The deployer account doesn't exist or isn't funded on the target network.

**Solution:**

```bash
# Fund your testnet account using Friendbot
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"

# Or use the Stellar Laboratory
# https://laboratory.stellar.org/#account-creator?network=test
```

#### Error: "insufficient balance" or "tx_insufficient_balance"

**Cause:** The account doesn't have enough XLM to cover the deployment fee and minimum balance.

**Solution:** Ensure your account has at least 10 XLM for testnet deployments. Deployment typically costs 0.1-1 XLM depending on contract size.

#### Error: "wasm file not found"

**Cause:** The WASM file wasn't built or is in the wrong location.

**Solution:**

```bash
# Rebuild the contract
cd contract
stellar contract build

# Verify the WASM exists
ls -lh target/wasm32-unknown-unknown/release/*.wasm
```

#### Error: "contract already exists" or "ContractAlreadyExists"

**Cause:** Trying to deploy with the same WASM hash that's already deployed.

**Solution:** This is usually fine - you can reuse the existing contract ID. If you need a fresh instance, modify the contract code slightly or use a different deployer account.

#### Error: "transaction malformed" or "tx_bad_seq"

**Cause:** Sequence number mismatch or network connectivity issues.

**Solution:**

```bash
# Check your network configuration
stellar config network list

# Verify you're using the correct network
stellar config network current

# Try again with explicit network flag
stellar contract deploy --network testnet --source mykey --wasm <path>
```

### Common Invocation Errors

#### Error: "ContractNotInitialized"

**Cause:** The `initialize()` function hasn't been called yet.

**Solution:**

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source mykey \
  -- initialize \
  --admin <ADMIN_ADDRESS>
```

#### Error: "ContractPaused"

**Cause:** The admin paused support calls.

**Solution:** Contact the contract admin to unpause, or if you're the admin:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source admin-key \
  -- unpause
```

#### Error: "InsufficientBalance"

**Cause:** The supporter account doesn't have enough of the selected asset.

**Solution:** Fund the supporter account with the required asset. For XLM:

```bash
curl "https://friendbot.stellar.org?addr=SUPPORTER_ADDRESS"
```

#### Error: "MessageTooLong"

**Cause:** The support message exceeds the maximum allowed length (typically 280 characters).

**Solution:** Shorten the message and try again.

#### Error: "InvalidAssetCode"

**Cause:** The asset code doesn't match the contract validation rules (1-12 alphanumeric characters).

**Solution:** Use a valid asset code like "XLM", "USDC", or "AQUA".

#### Error: "Unauthorized" or "NotAdmin"

**Cause:** Trying to call an admin-only function without admin privileges.

**Solution:** Ensure you're using the admin keypair that was set during initialization.

### Network and RPC Issues

#### Error: "connection refused" or "network timeout"

**Cause:** Can't reach the Soroban RPC endpoint.

**Solution:**

```bash
# Check RPC endpoint status
curl https://soroban-testnet.stellar.org/health

# Try alternative RPC endpoints
stellar config network add testnet-alt \
  --rpc-url https://rpc-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"

# Use the alternative network
stellar contract invoke --network testnet-alt ...
```

#### Error: "rate limit exceeded"

**Cause:** Too many requests to the public RPC endpoint.

**Solution:**

- Wait a few minutes and try again
- Use your own RPC node
- Batch multiple operations together
- Consider using a paid RPC provider for production

### Debugging Tips

1. **Enable verbose logging:**

   ```bash
   RUST_LOG=debug stellar contract invoke ...
   ```

2. **Check transaction in Stellar Expert:**
   - Go to https://stellar.expert/explorer/testnet
   - Search for your transaction hash
   - Review the operations and error details

3. **Verify contract state:**

   ```bash
   # Check contract support count
   stellar contract invoke --id <CONTRACT_ID> --network testnet -- support_count

   # Check total by asset for a recipient
   stellar contract invoke --id <CONTRACT_ID> --network testnet -- get_total_by_asset --r <RECIPIENT_ADDRESS> --asset <ASSET_ADDRESS>
   ```

4. **Test with Stellar Laboratory:**
   - Use https://laboratory.stellar.org to manually build and submit transactions
   - Helpful for debugging parameter encoding issues

5. **Check contract events:**
   ```bash
   stellar contract events --id <CONTRACT_ID> --network testnet --count 10
   ```

### Getting Help

If you're still stuck:

1. Check the [Stellar Discord](https://discord.gg/stellar) #soroban channel
2. Review [Soroban documentation](https://developers.stellar.org/docs/smart-contracts)
3. Search [Stellar Stack Exchange](https://stellar.stackexchange.com/)
4. File an issue in the [NovaSupport repository](https://github.com/your-org/novasupport/issues)

## Verification

After deploying, verify the contract is callable before shipping the frontend update.

### Query contract state

Use the Stellar CLI to confirm the global counter and recipient totals:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- support_count
```

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  -- recipient_count \
  --recipient <RECIPIENT_ADDRESS>
```

### Call the contract after deploy

Invoke `support()` once with a funded test account and then confirm the transaction appears in:

- Horizon transaction history
- The profile page transaction list
- Stellar Expert: https://stellar.expert/explorer/testnet/tx/<TX_HASH>

### Example state query

To inspect a deployed contract in the explorer, open the contract page and confirm the latest ledger activity:

https://stellar.expert/explorer/testnet/contract/<CONTRACT_ID>

## Testing & Verification

Before deploying, always run the local test suite to ensure contract logic is correct.

```bash
cd contract
cargo test
```

For more comprehensive verification, you can use the Stellar CLI to simulate invocations on a local or testnet network.

## Contract Invocation

After deploying the contract to Testnet, you can invoke the `support()` function using either the Stellar CLI or JavaScript.

### CLI Example

Use the Stellar CLI to call the contract directly:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source mykey \
  -- support \
  --s <SUPPORTER_ADDRESS> \
  --r <RECIPIENT_ADDRESS> \
  --asset <ASSET_ADDRESS> \
  --o 10000000 \
  --c XLM \
  --m "Great work!"
```

**Note:** The `amount` (`--o`) is in stroops (1 XLM = 10,000,000 stroops).

### JavaScript Example

Use `@stellar/stellar-sdk` to invoke the contract from JavaScript:

```javascript
import {
  Contract,
  SorobanRpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Address,
  nativeToScVal,
} from "@stellar/stellar-sdk";

const server = new SorobanRpc.Server("https://soroban-testnet.stellar.org");
const contract = new Contract("<CONTRACT_ID>");

// Get the supporter account
const account = await server.getAccount("<SUPPORTER_ADDRESS>");

// Build the transaction
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: Networks.TESTNET,
})
  .addOperation(
    contract.call(
      "support",
      nativeToScVal(Address.fromString("<SUPPORTER_ADDRESS>"), {
        type: "address",
      }),
      nativeToScVal(Address.fromString("<RECIPIENT_ADDRESS>"), {
        type: "address",
      }),
      nativeToScVal(Address.fromString("<ASSET_ADDRESS>"), {
        type: "address",
      }),
      nativeToScVal(10000000, { type: "i128" }), // amount in stroops
      nativeToScVal("XLM", { type: "string" }),
      nativeToScVal("Great work!", { type: "string" }),
    ),
  )
  .setTimeout(30)
  .build();

// Prepare the transaction
const preparedTx = await server.prepareTransaction(tx);

// Sign with Freighter or a keypair
// preparedTx.sign(keypair);

// Submit the transaction
// const result = await server.sendTransaction(preparedTx);
```

**Note:** Remember to sign the transaction with the supporter's keypair or using a wallet like Freighter before submitting.

### Deployment & Upgrades

Soroban contract code is immutable for a deployed contract ID. Treat every deploy as a new release candidate: test the WASM locally, deploy to Testnet, then update clients only after verification.

#### Pre-deploy verification

```bash
cd contract
cargo test
stellar contract build
```

Before updating `NEXT_PUBLIC_CONTRACT_ID` or backend indexer config, invoke the Testnet contract with a funded account and confirm `support_count` and `recipient_count` return expected values.

#### Initial Deployment

Follow these steps to build the WASM and deploy the contract to Stellar Testnet.

**Prerequisites:**

- Rust stable toolchain with `wasm32-unknown-unknown` target.
- Stellar CLI installed (`cargo install --locked stellar-cli`).
- A funded Testnet account (e.g., `mykey`).

```bash
# Build the contract
stellar contract build

# Deploy
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/support_page.wasm \
  --network testnet \
  --source mykey
```

After a successful deploy, the CLI will print the **Contract ID**. Update your frontend `.env.local` with:
`NEXT_PUBLIC_CONTRACT_ID=<YOUR_CONTRACT_ID>`

#### Upgrade Strategy

**The NovaSupport contract is immutable once deployed.** There is no built-in "upgrade" function or admin key that can swap the WASM code for an existing Contract ID.

To "upgrade" the contract:

1. **Deploy a new instance:** Re-run the deployment steps with your updated WASM. This will generate a **new Contract ID**.
2. **Update the Frontend:** Point your frontend application to the new Contract ID.
3. **State Migration:** If the old contract has critical state (like `support_count`) that must be preserved, you must:
   - Export the state from the old contract (via events or queries).
   - Write a migration script or include an "initialization" function in the new contract that imports the old values.
   - Note: For the current minimal version, a simple counter reset is usually acceptable for Dev/Testnet iterations.

**Security Warning:** Always verify the new WASM hash against the source code before deploying to a production-like environment.

## Rollback

Soroban contracts are immutable once deployed, so rollback means moving traffic away from the bad instance.

1. Stop using the current contract ID in the frontend and backend env files.
2. Deploy a fresh contract version from the last known-good source.
3. Update `NEXT_PUBLIC_CONTRACT_ID` and any backend indexer config to the new contract ID.
4. Confirm the new contract in Stellar Expert before resuming production traffic.

If the bad contract already received support events, preserve the old ID for auditability even after cutting over.

### Rollback Checklist

Before rolling back to a previous contract version:

- [ ] Identify the last known-good contract ID and source commit
- [ ] Verify the WASM hash matches the source code
- [ ] Deploy the new contract instance to testnet first
- [ ] Test critical functions (initialize, support, withdraw) on testnet
- [ ] Update environment variables in all services:
  - `frontend/.env.local` → `NEXT_PUBLIC_CONTRACT_ID`
  - `backend/.env` → `SOROBAN_CONTRACT_ID` or `CONTRACT_ID`
- [ ] Restart backend indexer to begin tracking the new contract
- [ ] Monitor Stellar Expert for the first few transactions
- [ ] Document the incident and root cause for future reference

### Emergency Rollback Script

```bash
#!/bin/bash
# emergency-rollback.sh - Quick rollback to previous contract

OLD_CONTRACT_ID="<CURRENT_BAD_CONTRACT_ID>"
NEW_CONTRACT_ID="<NEWLY_DEPLOYED_CONTRACT_ID>"

echo "Rolling back from $OLD_CONTRACT_ID to $NEW_CONTRACT_ID"

# Update frontend
sed -i "s/$OLD_CONTRACT_ID/$NEW_CONTRACT_ID/g" frontend/.env.local

# Update backend
sed -i "s/$OLD_CONTRACT_ID/$NEW_CONTRACT_ID/g" backend/.env

# Restart services (adjust for your deployment)
# pm2 restart backend
# vercel --prod  # or your frontend deployment command

echo "Rollback complete. Verify at:"
echo "https://stellar.expert/explorer/testnet/contract/$NEW_CONTRACT_ID"
```

Make the script executable: `chmod +x emergency-rollback.sh`

## Gas Estimation

Soroban contracts are metered by **CPU instructions** and **memory bytes**. Every `support()` call consumes resources that translate into a *resource fee* on top of the base transaction fee.

### How Stellar fees work

| Component | Description |
|-----------|-------------|
| **Base fee** | Fixed per-operation fee; default `BASE_FEE = 100` stroops |
| **Resource fee** | Variable fee based on CPU instructions, memory, ledger I/O, and transaction size |
| **Total fee** | `base_fee + resource_fee` (paid in XLM, 1 XLM = 10,000,000 stroops) |

### Typical gas costs for `support()`

The table below shows simulated resource consumption across representative scenarios. Actual values vary with network congestion and Soroban protocol version.

| Scenario | Amount | Message length | CPU Instructions | Memory | Min Resource Fee |
|----------|--------|---------------|-----------------|--------|-----------------|
| Minimal | 1 XLM | 10 chars | ~2,500,000 | ~600 KB | ~50,000 stroops (~0.005 XLM) |
| Typical | 5 XLM | 60 chars | ~3,000,000 | ~650 KB | ~60,000 stroops (~0.006 XLM) |
| Long message | 10 XLM | 200 chars | ~3,500,000 | ~700 KB | ~75,000 stroops (~0.0075 XLM) |
| Max message | 10 XLM | 280 chars | ~3,800,000 | ~720 KB | ~85,000 stroops (~0.0085 XLM) |

> **Key takeaway:** A typical support transaction costs well under **0.01 XLM** in fees. The dominant cost driver is the SAC token transfer (`transfer()`), not the message length.

### Factors that affect gas costs

1. **Message length** — The `message` parameter is stored in contract arguments and validated on-chain. Longer messages increase instruction count and transaction size slightly.
2. **Token transfer** — `token::Client::transfer()` is the most expensive single operation. It invokes the Stellar Asset Contract (SAC), which reads and writes ledger entries for both the supporter and the contract balances.
3. **Storage TTL extension** — Every `support()` call extends TTL for `SupportCount`, `RecipientCount`, and `RecipientTotal` entries, adding three ledger write operations.
4. **First-time recipient** — If the recipient has no prior transactions with this contract, two storage entries are created instead of updated, slightly increasing cost.
5. **Network congestion** — During high-traffic periods, the Soroban fee market may require a higher base fee for timely inclusion. Resource fees are unaffected by congestion.
6. **Protocol upgrades** — Soroban fee schedules are governed by validators and can change between protocol versions.

### Estimating gas before submitting

Use the Soroban RPC `simulateTransaction` endpoint to get exact fee estimates without spending XLM:

```bash
# Simulate via Stellar CLI (prints fee breakdown)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --network testnet \
  --source mykey \
  --fee 100000 \
  -- support \
  --s <SUPPORTER_ADDRESS> \
  --r <RECIPIENT_ADDRESS> \
  --asset <ASSET_ADDRESS> \
  --o 10000000 \
  --c XLM \
  --m "Great work!" \
  2>&1 | grep -E "(fee|instructions|memory)"
```

Or use the provided JavaScript estimation script:

```bash
# Install dependencies
cd contract
npm install @stellar/stellar-sdk

# Run against testnet (set your contract ID first)
CONTRACT_ID=C... node scripts/estimate-gas.js
```

The script (`scripts/estimate-gas.js`) simulates four scenarios — minimal, medium, long message, and max message — and prints CPU instructions, memory, and minimum resource fee for each.

### Gas optimization techniques

1. **Keep messages concise** — Every character in the `message` field adds to transaction size and argument-encoding cost. Encourage supporters to write meaningful but brief messages.
2. **Batch off-chain, settle on-chain** — If you need to record many micro-supports, consider batching them off-chain and submitting a single aggregated transaction.
3. **Reuse recipient entries** — The first support for a new recipient costs slightly more due to storage creation. Subsequent supports to the same recipient are cheaper.
4. **Set a sensible fee bump budget** — Use `BASE_FEE = 1000` stroops (10× default) during peak hours. The Stellar CLI `--fee` flag accepts stroops.
5. **Pre-fund the contract account** — Ensure the contract account has sufficient XLM for rent and minimum balance to avoid failed transactions due to insufficient funds.
6. **Avoid unnecessary re-initialization** — `initialize()` stores admin and paused keys once. Calling it again returns an error (no wasted gas), but calling it in error paths wastes CPU.

### Example: checking fee before submitting (JavaScript)

```javascript
import { SorobanRpc, TransactionBuilder, Networks, BASE_FEE } from "@stellar/stellar-sdk";

const server = new SorobanRpc.Server("https://soroban-testnet.stellar.org");

// Build transaction (see Contract Invocation section for full example)
const tx = buildSupportTransaction(account, contract, params);

// Simulate — no XLM spent
const sim = await server.simulateTransaction(tx);

if (!SorobanRpc.Api.isSimulationError(sim)) {
  console.log("Min resource fee (stroops):", sim.minResourceFee);
  console.log("CPU instructions:", sim.cost.cpuInsns);
  console.log("Memory (bytes):", sim.cost.memBytes);

  // Prepare and sign only after you are happy with the fee
  const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
  prepared.sign(keypair);
  await server.sendTransaction(prepared);
}
```

## Resources

- **Stellar Laboratory:** https://laboratory.stellar.org (browser-based testnet account funding and transaction builder)
- **Stellar Expert:** https://stellar.expert/explorer/testnet (blockchain explorer for verifying transactions and contract state)
- **Soroban CLI Docs:** https://developers.stellar.org/docs/tools/developer-tools/cli (official CLI documentation)
- **Horizon API Reference:** https://developers.stellar.org/api/horizon (REST API for querying Stellar network)

## Security Notes

- Keep your deploy key secure; consider using ephemeral or CI-specific keys for automated deploys.
- Never commit private keys or seed phrases to version control.
- Use hardware wallets or secure key management systems for production deployments.
- Verify WASM hashes before deploying to production-like environments.
