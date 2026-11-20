# NovaSupport Contract ABI

Reference implementation: `contract/contracts/support_page/src/lib.rs`

## Contract ID

Deploy the contract to Stellar Testnet, then set `NEXT_PUBLIC_CONTRACT_ID` in `frontend/.env.local` to the deployed contract ID.

This repository does not currently include a checked-in deployed contract ID.

## Functions

### `initialize(env, admin) -> Result<(), Error>`

Initializes the contract, setting the admin and pausing state. Can only be called once.

Parameters:

- `env: Env` - Soroban execution environment.
- `admin: Address` - Address that becomes the contract administrator. Must authorize the call via `require_auth()`.

Returns:

- `Result<(), Error>` - `Ok(())` on success.

Behavior:

- Rejects calls if the contract has already been initialized (`AlreadyInitialized`).
- Stores the `Admin` address in persistent storage.
- Sets the `Paused` flag to `false`.
- Extends TTL for both storage entries.

Errors:

- `AlreadyInitialized` (202) - Contract has already been initialized.
- Soroban auth failure - If `admin` does not authorize the call.

### `pause(env) -> Result<(), Error>`

Pauses the contract, preventing `support()` and `withdraw()` calls. Requires admin authorization.

Parameters:

- `env: Env` - Soroban execution environment.

Returns:

- `Result<(), Error>` - `Ok(())` on success.

Behavior:

- Loads `Admin` from persistent storage; fails with `ContractNotInitialized` if absent.
- Requires authorization from the admin address.
- Sets the `Paused` flag to `true`.
- Emits a `pause` event with the admin address and current timestamp.

Errors:

- `ContractNotInitialized` (201) - Contract has not been initialized.
- Soroban auth failure - If admin does not authorize the call.

### `unpause(env) -> Result<(), Error>`

Unpauses the contract, re-enabling `support()` and `withdraw()` calls. Requires admin authorization.

Parameters:

- `env: Env` - Soroban execution environment.

Returns:

- `Result<(), Error>` - `Ok(())` on success.

Behavior:

- Loads `Admin` from persistent storage; fails with `ContractNotInitialized` if absent.
- Requires authorization from the admin address.
- Sets the `Paused` flag to `false`.
- Emits an `unpause` event with the admin address and current timestamp.

Errors:

- `ContractNotInitialized` (201) - Contract has not been initialized.
- Soroban auth failure - If admin does not authorize the call.

### `support(env, supporter, recipient, asset, amount, asset_code, message) -> Result<u32, Error>`

Records a support action, transfers tokens from supporter to contract, updates per-recipient and per-asset accounting, and returns the updated global count.

Parameters:

- `env: Env` - Soroban execution environment.
- `supporter: Address` - Address that must authorize the call via `require_auth()`.
- `recipient: Address` - Address receiving support.
- `asset: Address` - Soroban token contract address to transfer.
- `amount: i128` - Amount to transfer. Must be positive.
- `asset_code: String` - Asset code label such as `"XLM"` or `"USDC"` (1-12 characters).
- `message: String` - Support message (1-280 characters).

Returns:

- `Result<u32, Error>` - The updated global support count after this call.

Behavior:

- Rejects calls if the contract is not initialized or is paused.
- Rejects calls where `amount <= 0`.
- Rejects calls with empty or oversized messages (max 280 characters).
- Rejects calls with empty or oversized asset codes (max 12 characters).
- Checks supporter token balance; rejects if insufficient.
- Transfers `amount` tokens from `supporter` to the contract via the Soroban token client.
- Increments the global `SupportCount`.
- Increments `RecipientCount` for this recipient.
- Adds `amount` to `RecipientTotal` for this recipient and asset pair.
- Emits a `support` event with the full payload including a timestamp.
- Returns the new global support count.

Errors:

- `ZeroAmount` (2) - `amount` is zero.
- `NegativeAmount` (3) - `amount` is negative.
- `EmptyMessage` (4) - `message` is empty.
- `MessageTooLong` (5) - `message` exceeds 280 characters.
- `InvalidAssetCode` (6) - `asset_code` is empty or exceeds 12 characters.
- `InsufficientBalance` (300) - Supporter does not have enough tokens.
- `Overflow` (302) - Arithmetic overflow in balance calculation.
- `ContractNotInitialized` (201) - Contract has not been initialized.
- `ContractPaused` (200) - Contract is paused.
- Soroban auth failure - If `supporter` does not authorize the call.

### `withdraw(env, caller, recipient, asset, amount) -> Result<(), Error>`

Allows a recipient to withdraw their supported funds from the contract.

Parameters:

- `env: Env` - Soroban execution environment.
- `caller: Address` - Address initiating the withdrawal. Must be the same as `recipient`. Must authorize via `require_auth()`.
- `recipient: Address` - Address receiving the withdrawn funds.
- `asset: Address` - Soroban token contract address to withdraw.
- `amount: i128` - Amount to withdraw. Must be positive and not exceed the recipient's balance.

Returns:

- `Result<(), Error>` - `Ok(())` on success.

Behavior:

- Rejects calls if the contract is not initialized or is paused.
- Rejects calls where `caller != recipient` (`NotRecipient`).
- Rejects calls where `amount <= 0`.
- Rejects calls if the recipient has never received support (`RecipientNotFound`).
- Rejects calls if the recipient's recorded balance is zero (`ZeroBalance`).
- Rejects calls if `amount` exceeds the recipient's recorded balance for this asset.
- Checks the contract's actual token balance; rejects if insufficient (`InsufficientContractBalance`).
- Transfers `amount` tokens from the contract to `recipient`.
- Deducts `amount` from `RecipientTotal` for this recipient and asset pair.
- Emits a `withdraw` event with the caller, asset, and amount.

Errors:

- `ZeroAmount` (2) - `amount` is zero.
- `NegativeAmount` (3) - `amount` is negative.
- `NotRecipient` (102) - `caller` is not the same as `recipient`.
- `ContractNotInitialized` (201) - Contract has not been initialized.
- `ContractPaused` (200) - Contract is paused.
- `RecipientNotFound` (402) - Recipient has never received support.
- `ZeroBalance` (403) - Recipient's recorded balance is zero.
- `WithdrawAmountExceedsBalance` (303) - Requested amount exceeds recipient's recorded balance.
- `InsufficientContractBalance` (301) - Contract does not hold enough tokens.
- `Overflow` (302) - Arithmetic overflow in balance calculation.
- Soroban auth failure - If `caller` does not authorize the call.

### `support_count(env) -> u32`

Returns the total number of successful `support()` calls recorded by the contract.

Parameters:

- `env: Env` - Soroban execution environment.

Returns:

- `u32` - Current global support count. Returns `0` when no support has been recorded.

### `recipient_count(env, recipient) -> u32`

Returns the number of support actions received by a specific recipient.

Parameters:

- `env: Env` - Soroban execution environment.
- `recipient: Address` - Address to query.

Returns:

- `u32` - Number of support actions for this recipient. Returns `0` if the recipient has never received support.

### `get_recipient_total(env, recipient, asset) -> i128`

Returns the total amount of a specific asset received by a specific recipient (including withdrawals deducted). Mirrors `get_total_by_asset` and reads from the same `RecipientTotal(Address, Address)` storage key (keyed by recipient and asset, returning a per-asset total rather than an aggregate across assets).

Parameters:

- `env: Env` - Soroban execution environment.
- `recipient: Address` - Address to query.
- `asset: Address` - Soroban token contract address to query.

Returns:

- `i128` - Total amount of this asset received by this recipient. Returns `0` if unknown.

### `get_total_by_asset(env, recipient, asset) -> i128`

Returns the total amount of a specific asset received by a specific recipient (including withdrawals deducted).

Parameters:

- `env: Env` - Soroban execution environment.
- `recipient: Address` - Address to query.
- `asset: Address` - Soroban token contract address to query.

Returns:

- `i128` - Total amount of this asset received by this recipient. Returns `0` if unknown.

## Events

### Topic: `"support"`

Emitted on every successful `support()` call.

Event payload type:

```rust
SupportEvent {
    supporter: Address,
    recipient: Address,
    amount: i128,
    asset_code: String,
    message: String,
    timestamp: u64,
}
```

Event fields:

- `supporter: Address` - Authorized caller.
- `recipient: Address` - Support recipient.
- `amount: i128` - Raw amount passed to `support()`.
- `asset_code: String` - Asset code label.
- `message: String` - Support message.
- `timestamp: u64` - Ledger timestamp at the time of the call.

### Topic: `"withdraw"`

Emitted on every successful `withdraw()` call.

Event fields (tuple):

- `caller: Address` - Address that initiated the withdrawal (must be the recipient).
- `asset: Address` - Soroban token contract address.
- `amount: i128` - Amount withdrawn.

### Topic: `"pause"`

Emitted on every successful `pause()` call.

Event fields (tuple):

- `admin: Address` - Admin that paused the contract.
- `timestamp: u64` - Ledger timestamp.

### Topic: `"unpause"`

Emitted on every successful `unpause()` call.

Event fields (tuple):

- `admin: Address` - Admin that unpaused the contract.
- `timestamp: u64` - Ledger timestamp.

## Storage Keys

| Key                                | Type      | Description                                                                                                                                                                                                                                        |
| ---------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SupportCount`                     | `u32`     | Global count of successful `support()` calls stored in persistent storage.                                                                                                                                                                         |
| `RecipientCount(Address)`          | `u32`     | Per-recipient count of support actions received.                                                                                                                                                                                                   |
| `RecipientTotal(Address, Address)` | `i128`    | Per-recipient, per-asset total amount received (reduced by withdrawals). Keyed by recipient address and asset token contract (first address is recipient, second is asset), representing a per-asset total rather than an aggregate across assets. |
| `Admin`                            | `Address` | Contract administrator address. Set during `initialize()`.                                                                                                                                                                                         |
| `Paused`                           | `bool`    | Whether the contract is paused. Toggled by `pause()` / `unpause()`.                                                                                                                                                                                |

## Error Codes

The contract defines a `#[contracterror]` enum with the following numeric variants:

| Error                          | Value | Meaning                                                          |
| ------------------------------ | ----- | ---------------------------------------------------------------- |
| `ZeroAmount`                   | 2     | `amount` is zero in `support()` or `withdraw()`.                 |
| `NegativeAmount`               | 3     | `amount` is negative in `support()` or `withdraw()`.             |
| `EmptyMessage`                 | 4     | `message` is empty in `support()`.                               |
| `MessageTooLong`               | 5     | `message` exceeds 280 characters in `support()`.                 |
| `InvalidAssetCode`             | 6     | `asset_code` is empty or exceeds 12 characters in `support()`.   |
| `NotRecipient`                 | 102   | `caller` is not the same as `recipient` in `withdraw()`.         |
| `ContractPaused`               | 200   | Contract is paused; `support()` or `withdraw()` rejected.        |
| `ContractNotInitialized`       | 201   | Contract has not been initialized.                               |
| `AlreadyInitialized`           | 202   | `initialize()` called more than once.                            |
| `InsufficientBalance`          | 300   | Supporter does not have enough tokens.                           |
| `InsufficientContractBalance`  | 301   | Contract does not hold enough tokens for withdrawal.             |
| `Overflow`                     | 302   | Arithmetic overflow in balance calculation (checked arithmetic). |
| `WithdrawAmountExceedsBalance` | 303   | Requested withdrawal exceeds recipient's recorded balance.       |
| `RecipientNotFound`            | 402   | Recipient has never received support.                            |
| `ZeroBalance`                  | 403   | Recipient's recorded balance is zero.                            |
