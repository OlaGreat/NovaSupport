# Contract Security Considerations

This document covers the security assumptions, trust model, and known limitations of the
`SupportPageContract` in `contracts/support_page/src/lib.rs`. Read it before making any
changes to the contract.

---

## What the contract guarantees

- **Supporter authorization.** `supporter.require_auth()` is called before any state change.
  No address can invoke `support()` on behalf of another address without that address
  signing the transaction.

- **Positive-amount enforcement.** `amount <= 0` panics with `"amount must be positive"`.
  Zero-value and negative-value calls are rejected at the contract level.

- **Persistent support count.** `SupportCount` is stored in persistent storage and survives
  ledger closings. The contract explicitly calls `extend_ttl()` after every write to ensure
  entries remain live; entries will not silently disappear between calls within their TTL window.

- **Structured event emission.** Every successful call emits a `SupportEvent` containing
  `supporter`, `recipient`, `amount`, `asset_code`, and `message` under the topic `"support"`.
  This gives indexers and the backend a consistent, verifiable record of each support action.

---

## What the contract does NOT guarantee

- **Fund custody and transfer via Soroban token client.** The contract transfers tokens to itself
  on `support()` and from itself on `withdraw()` using the Soroban token client. These transfers
  are atomic — both succeed or both fail. `SupportCount` and recipient totals are stored in
  persistent storage separately from the actual token balances. The backend is responsible for
  reconciling on-chain balances with stored counts.

- **No recipient validation.** The contract does not verify that `recipient` is a registered
  NovaSupport profile, a valid Stellar account, or has any relationship to the platform.
  Any address can be passed as `recipient`.

- **No duplicate-support prevention.** The same `supporter` can call `support()` multiple
  times for the same `recipient`. `SupportCount` is a global counter, not per-supporter.

- **Limited message validation.** `message` must be non-empty and no longer than 280
  characters (`support()` returns `EmptyMessage` / `MessageTooLong` otherwise). Beyond that
  length check, the contract does not enforce content policy or encoding beyond what the
  Soroban host imposes.

- **No asset verification.** `asset_code` is a free-form string. The contract does not
  verify that the string corresponds to a real Stellar asset or matches the payment
  operation in the transaction envelope.

---

## Trust model

- **Permissionless.** Anyone can call `support()` for any recipient address. There is no
  allowlist, role check, or admin gate on who may submit a support action.

- **Admin key required for privileged operations.** The contract has an admin address that must
  authorize pause/unpause operations via `require_auth()`. An upgrade path does not exist;
  contract code is immutable once deployed.

- **Immutable once deployed.** The contract has no `upgrade` entry point. Once deployed to a contract ID, the WASM cannot be altered, and the admin key confers no upgrade authority. This ensures that the logic seen at the time of deployment is what will always execute for that ID. Any "upgrade" requires deploying a new contract instance and updating the platform to use the new ID.

- **Events are trusted as-is.** The backend and frontend are responsible for validating
  event data. The contract emits whatever values it receives; it does not cross-check
  `asset_code` against the payment, or `amount` against any token balance.

- **`support_count` is a best-effort metric.** It counts invocations of `support()`, not
  unique supporters or verified payments. Do not use it as a financial audit trail.

## Deployment and upgrade security

There is no privileged upgrade path for an existing contract ID. A contract change requires:

1. Building and testing the new WASM locally with `cargo test` and `stellar contract build`.
2. Deploying a new contract instance, which produces a new contract ID.
3. Migrating any state that must survive the change by reading old contract state/events and initializing equivalent state in the new contract.
4. Updating frontend and backend environment variables to the new contract ID only after Testnet verification.

Keep the old contract ID in release notes and monitoring so historical events remain auditable. Never assume a frontend config change alone migrates on-chain state.

---

## Things to watch for when extending

- **Always call `require_auth()` for any address performing an action.** Omitting it allows
  anyone to invoke that function on behalf of any address.

- **Extend TTL on persistent storage writes.** If you add new persistent storage entries,
  call `env.storage().persistent().extend_ttl(key, threshold, extend_to)` after each write,
  or entries will expire and silently return `None` on the next read. The current contract
  explicitly calls `extend_ttl()` immediately after every `set()` — this is intentional and
  required. You must do the same for any new entry type you introduce; there is no automatic
  TTL extension on write.

- **Avoid storing unbounded data in persistent storage at scale.** Storing full message
  strings per supporter would make storage costs grow linearly with usage. Use events
  (as this contract does) for variable-length, per-call data.

- **Do not assume `amount` reflects a real token transfer.** If future logic gates behaviour
  on `amount` (e.g., tiered rewards), verify the corresponding payment operation is
  atomically linked in the transaction envelope — the contract currently makes no such check.

- **Test with `mock_all_auths()` but require real auth in production flows.** Tests use
  `env.mock_all_auths()` to bypass signature checks. Ensure any new function that touches
  sensitive state calls `require_auth()` on the appropriate address before shipping.

- **Global state is shared across all callers.** `SupportCount` is a single contract-wide
  counter. If you introduce per-user or per-recipient state, use a composite `DataKey`
  variant (e.g., `DataKey::UserCount(Address)`) to avoid collisions.

---

## Keeping this document in sync

This document must be updated whenever `lib.rs` changes. Review the guarantees and limitations
sections after any modification to the contract code, especially changes to:
- Authorization checks (`require_auth()` calls)
- Pause/unpause logic
- Fund transfer operations
- Storage model and TTL management

An out-of-sync SECURITY.md can mislead the backend and frontend teams into incorrect assumptions
about contract behaviour.
