# Soroban Contract Error Codes

This document describes all error codes used in the NovaSupport Soroban contract and their meanings.

## Error Code Categories

Error codes are organized into ranges by category:

- **1-99**: Input validation errors
- **100-199**: Authorization errors
- **200-299**: Contract state errors
- **300-399**: Balance and transfer errors
- **400-499**: Storage and data errors

## Error Code Reference

### Input Validation Errors (1-99)

| Code | Error Name         | Description                                     |
| ---- | ------------------ | ----------------------------------------------- |
| 2    | `ZeroAmount`       | Amount cannot be zero                           |
| 3    | `NegativeAmount`   | Amount cannot be negative                       |
| 4    | `EmptyMessage`     | Message cannot be empty when required           |
| 5    | `MessageTooLong`   | Message exceeds maximum length (280 characters) |
| 6    | `InvalidAssetCode` | Asset code is invalid or empty                  |

### Authorization Errors (100-199)

| Code | Error Name     | Description                          |
| ---- | -------------- | ------------------------------------ |
| 102  | `NotRecipient` | Caller is not the intended recipient |

### Contract State Errors (200-299)

| Code | Error Name               | Description                           |
| ---- | ------------------------ | ------------------------------------- |
| 200  | `ContractPaused`         | Contract is currently paused          |
| 201  | `ContractNotInitialized` | Contract has not been initialized     |
| 202  | `AlreadyInitialized`     | Contract has already been initialized |

### Balance and Transfer Errors (300-399)

| Code | Error Name                     | Description                                       |
| ---- | ------------------------------ | ------------------------------------------------- |
| 300  | `InsufficientBalance`          | Supporter has insufficient token balance          |
| 301  | `InsufficientContractBalance`  | Contract has insufficient balance for withdrawal  |
| 302  | `Overflow`                     | Arithmetic overflow detected in checked operation |
| 303  | `WithdrawAmountExceedsBalance` | Withdrawal amount exceeds recipient's balance     |

### Storage and Data Errors (400-499)

| Code | Error Name          | Description                                              |
| ---- | ------------------- | -------------------------------------------------------- |
| 402  | `RecipientNotFound` | Recipient has no balance for the specified asset         |
| 403  | `ZeroBalance`       | Recipient has a zero balance for the requested operation |

## Usage Examples

### Handling Specific Errors

```rust
match client.support(&supporter, &recipient, &asset, &amount, &code, &message) {
    Ok(count) => println!("Support successful, count: {}", count),
    Err(Error::ZeroAmount) => println!("Amount must be greater than zero"),
    Err(Error::ContractPaused) => println!("Contract is currently paused"),
    Err(Error::InsufficientBalance) => println!("Insufficient token balance"),
    Err(e) => println!("Other error: {:?}", e),
}
```

### Common Error Scenarios

1. **Support Transaction Errors**:
   - `ZeroAmount` (2): User tries to send 0 tokens
   - `NegativeAmount` (3): Invalid negative amount
   - `ContractPaused` (200): Contract is paused by admin
   - `InsufficientBalance` (300): User doesn't have enough tokens
   - `MessageTooLong` (5): Support message exceeds 280 characters
   - `Overflow` (302): Arithmetic overflow in balance calculation

2. **Withdrawal Errors**:
   - `NotRecipient` (102): Someone other than recipient tries to withdraw
   - `WithdrawAmountExceedsBalance` (303): Trying to withdraw more than available
   - `RecipientNotFound` (402): No balance exists for this recipient/asset pair
   - `ZeroBalance` (403): Recipient balance is zero
   - `Overflow` (302): Arithmetic overflow in balance calculation

3. **Admin Operation Errors**:
   - `ContractNotInitialized` (201): Operations before initialization
   - `AlreadyInitialized` (202): Trying to initialize twice

> **Note:** Admin operations like `pause()` and `unpause()` use
> `admin.require_auth()` which traps on authorization failure rather than
> returning a catchable `Error`. There is no `NotAdmin` error code —
> authorization failures surface as a Soroban auth trap.

## Best Practices

1. **Always check for initialization** before performing operations
2. **Validate inputs** on the client side to avoid unnecessary transaction fees
3. **Handle specific error codes** rather than generic error catching
4. **Provide user-friendly error messages** based on error codes
5. **Test all error scenarios** in your integration tests
